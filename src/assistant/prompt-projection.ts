import {randomUUID} from 'node:crypto';
import type {Store} from '../coordination/contracts.js';
import {canonical} from './tool-governance.js';
import {requestHash,diagnosticHostFields,type PromptDescriptor} from '../models/prompt-diagnostics.js';
import {createContextOutputs,type ContextEvent} from './assistant-context.js';

export type PromptStrategy='legacy'|'stable-prefix-v1';
export type GenerationReason='explicit_strategy_switch'|'layout_version'|'optimization_mode'|'catalog_contract'|'model_route'|'compaction'|'history_rewind'|'permission_scope_change'|'instructions';
interface Session {id:string;version:number;summary:string;compacted_through:number}
interface Generation {id:string;session_id:string;boundary:string;header:string;checkpoint:string;scan_watermark:number;instruction_hash:string;instruction_version:number;reason:GenerationReason;discoveries:string;integrity:string;manifest:string}
interface Frame {sequence:number;event_id:number|null;source_hash:string;rendered_text:string;rendered_hash:string}
export interface ProjectionInput {session:Session;instruction:string;catalog:unknown;discoveries:unknown[];mode:string;routeRevision:number|null;value:Record<string,any>;history:ContextEvent[]}
const excluded=new Set(['activity','context_budget','optimization_changed','supervision_waiting']);
// 新事件必须先归类，不能以“未知”名义丢弃权限、失败或用户约束。
const facts=new Set(['memory_recalled','compacted','message','request','request_answer','intent_confirmed','answer','tool_started','tool_result','tool_retry','tool_loop_stopped','operation_reused','knowledge_scope_changed','process_unknown','restart_interrupted','stopped','resumed','error','verification_contract','verification_evidence','completion_rejected','delivery_verified','protocol_repair','model_retry','inference_accounting_failure','delegation_result','delegation_blocked','supervision_event','child_stop_error','memory_edited','task_baseline_limited','task_started','review_snapshot','review_snapshot_expired','task_baseline','delivery_record','delivery_summary','delivery_accepted','delivery_changes_requested','file_edit_intent','file_edit_result','file_recovery_checked','command_intent','command_identity','command_finished','command_recovery_checked','command_log_anchor','command_log_expired','npm_validation_started','npm_validation_prepared','npm_validation_step','npm_validation_finished']);
const line=(kind:string,value:unknown)=>kind+' '+canonical(value)+'\n';
const sourceHash=(e:ContextEvent)=>requestHash(canonical(e));

/** 私有模型视图；原始事件和输出引用仍是事实源，GET 只允许无写入预览。 */
export function createPromptProjection(store:Store,outputs:ReturnType<typeof createContextOutputs>){
  const {db,row,rows}=store;
  db.exec(`CREATE TABLE IF NOT EXISTS assistant_prompt_settings(
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
    PRIMARY KEY(generation_id,sequence),UNIQUE(generation_id,event_id));`);
  function settings(id:string){
    const s=row<{strategy:PromptStrategy;version:number;active_generation:string|null}>('SELECT * FROM assistant_prompt_settings WHERE session_id=?',id);
    return {promptStrategy:s?.strategy??'legacy',promptSettingsVersion:s?.version??0,generation:s?.active_generation??null};
  }
  function configure(id:string,strategy:PromptStrategy,version:number){
    if(settings(id).promptSettingsVersion!==version)throw new Error('提示词设置版本已变化，请刷新');
    db.prepare('INSERT INTO assistant_prompt_settings VALUES (?,?,?,NULL) ON CONFLICT(session_id) DO UPDATE SET strategy=excluded.strategy,version=excluded.version,active_generation=NULL').run(id,strategy,version+1);
  }
  function events(s:Session){
    const watermark=row<{id:number}>('SELECT COALESCE(MAX(id),0) id FROM assistant_events WHERE session_id=?',s.id)!.id;
    const all:ContextEvent[]=[];let cursor=s.compacted_through;
    while(cursor<watermark){const page=rows<ContextEvent>('SELECT id,role,kind,body FROM assistant_events WHERE session_id=? AND id>? AND id<=? ORDER BY id LIMIT 200',s.id,cursor,watermark);if(!page.length)break;all.push(...page);cursor=page.at(-1)!.id;}
    return all;
  }
  function prepare(input:ProjectionInput,persist=false,forceReason?:GenerationReason){
    const {session:s,value,history}=input;
    if(row<{version:number}>('SELECT version FROM assistant_sessions WHERE id=?',s.id)?.version!==s.version)throw new Error('投影准备期间会话已变化');
    for(const e of history)if(!excluded.has(e.kind)&&!facts.has(e.kind))throw new Error('unsupported_event_kind: '+e.kind);
    const configured=settings(s.id),active=configured.generation?row<Generation>('SELECT * FROM assistant_prompt_generations WHERE id=? AND session_id=?',configured.generation,s.id):undefined;
    if(configured.generation&&!active)throw new Error('prompt_generation_missing: 当前代不存在');
    const header='APIX_AGENT_LOOP_JSON\nAPIX_PROMPT_LAYOUT stable-prefix-v1\n'+input.instruction+'\n项目指令以最新 project_instructions 版本为准，完整替换旧版本；revoked=true 明确撤销旧指令。发现工具以 CHECKPOINT 和新 EVENT 中的完整定义为准，已发现工具以 CURRENT_STATE.availableDiscoveredTools 的当前版本为准，只使用匹配版本的完整定义，缺失时重新 search_tools；执行权限仍由宿主校验决定。\n'+line('STABLE_CONTEXT',{catalog:input.catalog,contextReadPolicy:value.contextReadPolicy??null});
    const boundary={layout:1,mode:input.mode,route:input.routeRevision,catalog:requestHash(canonical(input.catalog)),permission:requestHash(canonical([value.policy,value.toolAccess])),through:s.compacted_through,summary:requestHash(s.summary),instruction:requestHash(header)};
    let reason:GenerationReason=forceReason??'explicit_strategy_switch';
    if(active&&!forceReason){const old=JSON.parse(active.boundary);reason=old.through>boundary.through?'history_rewind':old.through!==boundary.through||old.summary!==boundary.summary?'compaction':old.permission!==boundary.permission?'permission_scope_change':old.mode!==boundary.mode?'optimization_mode':old.route!==boundary.route?'model_route':old.catalog!==boundary.catalog?'catalog_contract':old.instruction!==boundary.instruction?'instructions':'layout_version';}
    const priorDiscoveries=active?JSON.parse(active.discoveries) as {name:string}[]:[];
    const invalidDiscovery=priorDiscoveries.some(old=>!input.discoveries.some(current=>canonical(current)===canonical(old)));
    const reuse=!!active&&!forceReason&&canonical(boundary)===active.boundary&&!invalidDiscovery;
    if(invalidDiscovery&&!forceReason)reason='catalog_contract';
    const rules=value.context?.instructions??[];
    const rulesHash=requestHash(canonical(rules));
    const gen:Generation=reuse?{...active!}:{id:randomUUID(),session_id:s.id,boundary:canonical(boundary),header,checkpoint:line('CHECKPOINT',{summary:s.summary,through:s.compacted_through,instructions:rules,discoveredTools:input.discoveries,initialRequest:value.initialRequest,latestUserRequest:value.latestUserRequest,taskFeedback:value.taskFeedback,currentTask:value.currentTask}),scan_watermark:s.compacted_through,instruction_hash:'',instruction_version:0,reason,discoveries:canonical(input.discoveries),integrity:'',manifest:''};
    if(reuse&&gen.integrity!==requestHash(gen.header+gen.checkpoint))throw new Error('prompt_generation_integrity: 固定头或检查点已改写');
    gen.integrity=requestHash(gen.header+gen.checkpoint);
    const saved=reuse?rows<Frame>('SELECT * FROM assistant_prompt_frames WHERE generation_id=? ORDER BY sequence',gen.id):[];
    if(reuse&&gen.manifest!==requestHash(canonical(saved.map(f=>[f.sequence,f.event_id,f.source_hash,f.rendered_hash]))))throw new Error('prompt_frame_integrity: 帧集合已改变');
    let previousEvent=0;
    for(const [index,f] of saved.entries()){
      if(f.sequence!==index+1||f.event_id!==null&&f.event_id<=previousEvent)throw new Error('prompt_frame_integrity: 帧顺序不一致');
      if(f.event_id!==null)previousEvent=f.event_id;
      if(requestHash(f.rendered_text)!==f.rendered_hash)throw new Error('prompt_frame_integrity: 已保存模型帧被改写');
      if(f.event_id!==null){const e=history.find(e=>e.id===f.event_id);if(!e||sourceHash(e)!==f.source_hash)throw new Error('prompt_source_changed: 原始事件已移除或改写');}
    }
    const additions:Frame[]=[];let sequence=saved.length;
    const append=(rendered:string,event:ContextEvent|null)=>additions.push({sequence:++sequence,event_id:event?.id??null,source_hash:event?sourceHash(event):rulesHash,rendered_text:rendered,rendered_hash:requestHash(rendered)});
    if(gen.instruction_hash!==rulesHash){
      append(line('EVENT',{kind:'project_instructions',version:gen.instruction_version+1,supersedes:gen.instruction_version||null,revoked:rules.length===0,instructions:rules}),null);
      gen.instruction_hash=rulesHash;gen.instruction_version++;
    }
    const visible=new Map<string,number>();
    if(input.mode==='saving')for(const f of saved){if(f.event_id===null)continue;const e=history.find(e=>e.id===f.event_id)!;const body=JSON.parse(e.body);const rendered=JSON.parse(f.rendered_text.slice(6));if(body?.ok===true&&['read_file','read_context'].includes(body.tool)&&!rendered.body?.result?.contentAlreadyInHistory)visible.set(canonical(body),e.id);}
    const write=()=>{
      for(const e of history.filter(e=>e.id>gen.scan_watermark)){
        if(excluded.has(e.kind))continue;
        const original=JSON.parse(e.body);
        // 工作片段和发现的完整 Schema 不走日志预览，首次表示确定后整代冻结。
        const full=['read_file','read_context','read_output','search_tools'].includes(original?.tool);
        let body=full?original:outputs.history(s.id,[e],false,false,persist)[0]!.body;
        if(input.mode==='saving'&&e.kind==='tool_result'&&original?.ok===true&&['read_file','read_context'].includes(original.tool)&&typeof (original.result?.content??original.result?.text)==='string'){
          const key=canonical(original),target=visible.get(key);
          if(target!==undefined){const {content:_,text:__,...metadata}=original.result;body={...original,result:{...metadata,contentAlreadyInHistory:true,duplicateOfEventId:target}};}else visible.set(key,e.id);
        }
        append(line('EVENT',{id:e.id,role:e.role,kind:e.kind,body}),e);
      }
      gen.scan_watermark=history.at(-1)?.id??s.compacted_through;gen.discoveries=canonical(input.discoveries);
      gen.manifest=requestHash(canonical([...saved,...additions].map(f=>[f.sequence,f.event_id,f.source_hash,f.rendered_hash])));
      if(persist){
        db.prepare('INSERT INTO assistant_prompt_generations VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scan_watermark=excluded.scan_watermark,instruction_hash=excluded.instruction_hash,instruction_version=excluded.instruction_version,discoveries=excluded.discoveries,manifest=excluded.manifest').run(gen.id,s.id,gen.boundary,gen.header,gen.checkpoint,gen.scan_watermark,gen.instruction_hash,gen.instruction_version,gen.reason,gen.discoveries,gen.integrity,gen.manifest);
        for(const f of additions)db.prepare('INSERT INTO assistant_prompt_frames VALUES (?,?,?,?,?,?)').run(gen.id,f.sequence,f.event_id,f.source_hash,f.rendered_text,f.rendered_hash);
        db.prepare('UPDATE assistant_prompt_settings SET active_generation=? WHERE session_id=?').run(gen.id,s.id);
      }
      const all=[...saved,...additions],core=gen.header+gen.checkpoint+all.map(f=>f.rendered_text).join('');
      const {history:_,summary:__,deferredTools:___,context:contextValue,contextReadPolicy:_______,initialRequest:____,latestUserRequest:_____,taskFeedback,...state}=value;
      const {instructions:______,...context}=contextValue??{};
      const initial=row<{id:number}>("SELECT id FROM assistant_events WHERE session_id=? AND role='user' AND kind='message' ORDER BY id LIMIT 1",s.id),latest=row<{id:number}>("SELECT id FROM assistant_events WHERE session_id=? AND role='user' AND kind='message' ORDER BY id DESC LIMIT 1",s.id);
      const {description:________,...currentTask}=value.currentTask??{};
      const tailState={...state,availableDiscoveredTools:input.discoveries.map(t=>{const tool=t as {name:string;version?:string};return {name:tool.name,version:tool.version??''};}),currentTask:value.currentTask?currentTask:null,context,initialRequest:initial?{eventId:initial.id}:null,latestUserRequest:latest?{eventId:latest.id}:null,taskFeedback:taskFeedback?.map((f:any)=>({deliveryId:f.deliveryId,taskId:f.taskId})),projectInstructions:{version:gen.instruction_version,hash:gen.instruction_hash,precedence:'最新 project_instructions 完整替换旧版本；revoked=true 撤销旧项目指令。当前权限以宿主为准。'}};
      const tail=line('CURRENT_STATE',tailState);
      const ending='只返回固定 JSON action 契约中的一个对象。\n',prompt=core+tail+ending,coreBytes=Buffer.byteLength(core),tailBytes=Buffer.byteLength(tail);
      const descriptor:PromptDescriptor={schema:1,layout:'stable-prefix-v1',generation:gen.id,generationReason:gen.reason,promptSha256:requestHash(prompt),coreEnd:coreBytes,tailEnd:coreBytes+tailBytes,regions:[{name:'instruction',start:0,end:Buffer.byteLength(gen.header)},{name:'checkpoint',start:Buffer.byteLength(gen.header),end:Buffer.byteLength(gen.header+gen.checkpoint)},{name:'events',start:Buffer.byteLength(gen.header+gen.checkpoint),end:coreBytes},{name:'current_state',start:coreBytes,end:coreBytes+tailBytes},{name:'ending',start:coreBytes+tailBytes,end:Buffer.byteLength(prompt)}],fields:diagnosticHostFields.filter(name=>Object.hasOwn(tailState,name)).map(name=>({name,hash:requestHash(canonical((tailState as Record<string,unknown>)[name]))})),frames:all.filter(f=>f.event_id!==null).map(f=>({eventId:f.event_id!,hash:f.rendered_hash}))};
      return {prompt,descriptor,coreText:core};
    };
    if(!persist)return write();
    db.exec('SAVEPOINT prompt_projection');try{const rendered=write();db.exec('RELEASE prompt_projection');return rendered;}catch(e){db.exec('ROLLBACK TO prompt_projection;RELEASE prompt_projection');throw e;}
  }
  return {settings,configure,events,prepare};
}
