/**
 * 上下文窗口管理 (Context Window) — Token 预算控制、上下文组装与截断、工具结果折叠与引用回读
 *
 * 所属层级：助手层 - 上下文管理
 * 核心功能：
 *   1. 估算 Token 数量（UTF-8 字节数 / 3 的粗略估算）
 *   2. 将大型工具结果折叠为引用，原始数据存入 assistant_outputs 表
 *   3. 上下文预算分解（contextBreakdown）——统计各部分占用多少 Token
 *   4. 安全截断（compactPrefix）——确保不拆开一次完整的工具执行（tool_started + tool_result）
 * 依赖关系：
 *   - 被 [→ 见 src/assistant/assistant-loop.ts] 的 assemble/context 调用
 *   - 调用 [→ 见 src/assistant/assistant-result.ts] 的 hostResultSummary 提取执行状态标志
 */
import {createHash,randomUUID} from 'node:crypto';
import type {Store} from '../coordination/contracts.js';
import {hostResultSummary} from './assistant-result.js';

/** 上下文事件接口 — 对应 assistant_events 表的一行 */
export interface ContextEvent {id:number;role:string;kind:string;body:string}
/**
 * estimateTokens - 粗略估算 Token 数量
 * @param value - 待估算的值（字符串或对象，对象会先 JSON 序列化）
 * @returns 估算的 Token 数（UTF-8 字节数 / 3，向上取整）
 */
export const estimateTokens=(value:unknown)=>Math.ceil(Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value),'utf8')/3);
/**
 * contextWindow - 校验并返回上下文窗口大小
 * @param value - 用户配置的窗口大小
 * @returns 有效的窗口 Token 数（范围 4096–1000000）
 */
export function contextWindow(value:unknown){const n=Number(value??32768);if(!Number.isSafeInteger(n)||n<4096||n>1000000)throw new Error('上下文窗口应为 4096–1000000 Token');return n;}
/**
 * createContextOutputs - 创建上下文输出管理器，负责工具结果的折叠、存储和引用回读
 * @param store - 数据库存储接口
 * @returns 包含 history/index/read 方法的对象
 * 设计意图：大型工具结果会占用大量上下文空间，此模块将大结果存入 assistant_outputs 表，
 * 在模型上下文中只保留引用（outputRef + 预览），模型可通过 read_context 工具回读完整结果。
 */
export function createContextOutputs(store:Store){
  const {db,row,rows,now}=store;
  db.exec('CREATE TABLE IF NOT EXISTS assistant_outputs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES assistant_sessions(id),event_id INTEGER NOT NULL,body TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS assistant_output_event ON assistant_outputs(session_id,event_id)');
  function history(sessionId:string,events:ContextEvent[],fold=false,saving=false){
    // 文件页不因事件变旧立即折叠；额外保留池按 UTF-8 限制单页 24 KiB、去重后 32 KiB，池外沿用原规则。
    const inlineFiles=new Set<string>();let fileBytes=0;
    if(saving)for(const e of [...events].reverse()){
      const body=JSON.parse(e.body),bytes=Buffer.byteLength(e.body,'utf8');
      if(e.kind==='tool_result'&&body?.tool==='read_file'&&body.ok===true&&typeof body.result?.content==='string'&&bytes<=24*1024&&!inlineFiles.has(e.body)&&fileBytes+bytes<=32*1024){inlineFiles.add(e.body);fileBytes+=bytes;}
    }
    const projected=events.map((e,index)=>{
    const body=JSON.parse(e.body);if(inlineFiles.has(e.body)||!['tool_started','tool_result','delegation_result','supervision_event','file_edit_result','delivery_summary','delivery_record','verification_evidence','npm_validation_started','npm_validation_prepared','npm_validation_finished'].includes(e.kind)||e.body.length<=(fold&&index<events.length-8?800:saving&&index<events.length-2?1200:8000)||body.tool==='read_context'||body.tool==='read_output')return {...e,body};
    let saved=row<{id:string;sha256:string}>('SELECT id,sha256 FROM assistant_outputs WHERE session_id=? AND event_id=?',sessionId,e.id);
    if(!saved){const id=randomUUID(),sha256=createHash('sha256').update(e.body).digest('hex');db.prepare('INSERT INTO assistant_outputs VALUES (?,?,?,?,?,?)').run(id,sessionId,e.id,e.body,sha256,now());saved={id,sha256};}
    // 退出码、失败与未知状态必须随引用保留，避免精简正文后把失败误读为成功。
    const result=body.result??body;const flags=hostResultSummary(result);
    const reference={...flags,outputRef:saved.id,sha256:flags.sha256??saved.sha256,savedResultSha256:saved.sha256,referenceKind:'tool_result_json',characters:e.body.length,preview:e.body.slice(0,fold?200:1200),fullResultAvailable:true};
    return {...e,body:e.kind==='tool_started'?{tool:body.tool,args:{path:body.args?.path,executable:body.args?.executable,...reference}}:{tool:body.tool,ok:body.ok,result:reference}};
    });
    if(!saving)return projected;
    const visible=new Map<string,number>();
    return projected.map(e=>{
      if(e.kind!=='tool_result'||!e.body||typeof e.body!=='object')return e;
      const body=e.body,result=body.result;
      if(body.ok!==true||!['read_file','read_context'].includes(body.tool)||!result||typeof result.content!=='string'&&typeof result.text!=='string')return e;
      const key=JSON.stringify(body),previous=visible.get(key);
      if(previous===undefined){visible.set(key,e.id);return e;}
      // 仅去掉本次上下文中已完整出现的相同正文；哈希、范围、游标与宿主状态均保留，原始事件不改写。
      const {content:_,text:__,...metadata}=result;
      return {...e,body:{...body,result:{...metadata,contentAlreadyInHistory:true,duplicateOfEventId:previous}}};
    });
  }
  return {history,index:(sessionId:string)=>rows('SELECT id,event_id,sha256,length(body) AS characters FROM assistant_outputs WHERE session_id=? AND id NOT LIKE \'log-%\' ORDER BY event_id DESC LIMIT 20',sessionId),read(sessionId:string,args:Record<string,unknown>){const saved=row<{body:string;sha256:string}>('SELECT body,sha256 FROM assistant_outputs WHERE id=? AND session_id=?',String(args.id),sessionId);if(!saved)throw new Error('上下文引用不存在或不属于本会话');if(JSON.parse(saved.body)?.kind==='command_log_v1')throw new Error('命令日志请用 read_output 读取，不能作为不可变上下文引用分页');const offset=Number(args.offset??0),limit=Number(args.limit??4000);if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>6000)throw new Error('上下文读取范围无效');return {id:args.id,sha256:saved.sha256,offset,text:saved.body.slice(offset,offset+limit),nextOffset:offset+limit<saved.body.length?offset+limit:null,characters:saved.body.length};}};
}
/**
 * contextBreakdown - 分解上下文预算，统计各部分占用了多少 Token
 * @param instruction - 系统指令
 * @param catalog - 工具目录
 * @param value - 完整上下文对象
 * @returns 包含各类别 Token 数、总使用量、窗口大小和目标大小的预算报告
 */
export function contextBreakdown(instruction:string,catalog:unknown,value:Record<string,any>){
  const context=value.context??{},history=value.history??[];
  const parts:Record<string,unknown>={system:instruction,instructions:context.instructions??[],memoryIndex:value.memoryIndex,recalled:value.recalledMemories,skills:context.skills??[],tools:catalog,task:{currentTask:value.currentTask,latestUserRequest:value.latestUserRequest,initialRequest:value.initialRequest,taskFeedback:value.taskFeedback},history:history.filter((e:any)=>!['tool_started','tool_result'].includes(e.kind)),toolResults:history.filter((e:any)=>['tool_started','tool_result'].includes(e.kind))};
  const tokens=Object.fromEntries(Object.entries(parts).map(([key,v])=>[key,estimateTokens(v??null)]));
  // JSON 结构、策略、摘要、任务校验和引用等剩余开销统一归入 other，避免漏算。
  const total=estimateTokens(instruction)+estimateTokens(catalog)+estimateTokens(value);
  tokens.other=Math.max(0,total-Object.values(tokens).reduce((a,b)=>a+b,0));
  return {schema:1,estimated:true,estimator:'utf8_bytes_divided_by_3',categories:tokens,usedTokens:Object.values(tokens).reduce((a,b)=>a+b,0),windowTokens:value.contextBudget.windowTokens,targetTokens:value.contextBudget.inputTargetTokens};
}
/** trimHistory - 过滤历史事件，移除系统内部事件（context_budget/optimization_changed），保留最近 8 条活动记录 */
export function trimHistory(events:ContextEvent[]){return events.filter((e,i)=>!['context_budget','optimization_changed'].includes(e.kind)&&(i>=events.length-8||!['activity','memory_recalled','context_budget','compacted'].includes(e.kind)));}
// 摘要边界不能拆开一次工具执行；启动、期间命令事件与最终结果必须作为完整执行组保留。
/**
 * compactPrefix - 计算安全截断位置，确保不拆开一次完整的工具执行
 * @param events - 历史事件列表
 * @param keep - 保留末尾多少条事件（默认 8）
 * @returns 安全截断的事件索引
 * 设计意图：tool_started 和 tool_result 必须作为完整对保留，不能截断中间
 */
export function compactPrefix(events:ContextEvent[],keep=8){
  let end=Math.max(0,events.length-keep);let open=-1;
  for(let i=0;i<end;i++){if(events[i]!.kind==='tool_started')open=i;if(events[i]!.kind==='tool_result')open=-1;}
  if(open>=0)end=open;return end;
}
