import {createHash,randomUUID} from 'node:crypto';
import type {Store} from '../coordination/contracts.js';
import {hostResultSummary} from './assistant-result.js';

export interface ContextEvent {id:number;role:string;kind:string;body:string}
export const estimateTokens=(value:unknown)=>Math.ceil(Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value),'utf8')/3);
export function contextWindow(value:unknown){const n=Number(value??32768);if(!Number.isSafeInteger(n)||n<4096||n>1000000)throw new Error('上下文窗口应为 4096–1000000 Token');return n;}
export function createContextOutputs(store:Store){
  const {db,row,rows,now}=store;
  db.exec('CREATE TABLE IF NOT EXISTS assistant_outputs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES assistant_sessions(id),event_id INTEGER NOT NULL,body TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS assistant_output_event ON assistant_outputs(session_id,event_id)');
  // 只折叠模型上下文，不删除原始结果；旧的 800 字符规则优先，引用回读结果不再折叠。
  function history(sessionId:string,events:ContextEvent[],fold=false,saving=false){return events.map((e,index)=>{
    const body=JSON.parse(e.body);if(!['tool_started','tool_result','delegation_result','supervision_event','file_edit_result','delivery_summary','delivery_record','verification_evidence','npm_validation_started','npm_validation_prepared','npm_validation_finished'].includes(e.kind)||e.body.length<=(fold&&index<events.length-8?800:saving&&index<events.length-2?1200:8000)||body.tool==='read_context'||body.tool==='read_output')return {...e,body};
    let saved=row<{id:string;sha256:string}>('SELECT id,sha256 FROM assistant_outputs WHERE session_id=? AND event_id=?',sessionId,e.id);
    if(!saved){const id=randomUUID(),sha256=createHash('sha256').update(e.body).digest('hex');db.prepare('INSERT INTO assistant_outputs VALUES (?,?,?,?,?,?)').run(id,sessionId,e.id,e.body,sha256,now());saved={id,sha256};}
    // 退出码、失败与未知状态必须随引用保留，避免精简正文后把失败误读为成功。
    const result=body.result??body;const flags=hostResultSummary(result);
    const reference={...flags,outputRef:saved.id,sha256:flags.sha256??saved.sha256,savedResultSha256:saved.sha256,referenceKind:'tool_result_json',characters:e.body.length,preview:e.body.slice(0,fold?200:1200),fullResultAvailable:true};
    return {...e,body:e.kind==='tool_started'?{tool:body.tool,args:{path:body.args?.path,executable:body.args?.executable,...reference}}:{tool:body.tool,ok:body.ok,result:reference}};
  });}
  return {history,index:(sessionId:string)=>rows('SELECT id,event_id,sha256,length(body) AS characters FROM assistant_outputs WHERE session_id=? AND id NOT LIKE \'log-%\' ORDER BY event_id DESC LIMIT 20',sessionId),read(sessionId:string,args:Record<string,unknown>){const saved=row<{body:string;sha256:string}>('SELECT body,sha256 FROM assistant_outputs WHERE id=? AND session_id=?',String(args.id),sessionId);if(!saved)throw new Error('上下文引用不存在或不属于本会话');if(JSON.parse(saved.body)?.kind==='command_log_v1')throw new Error('命令日志请用 read_output 读取，不能作为不可变上下文引用分页');const offset=Number(args.offset??0),limit=Number(args.limit??4000);if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>6000)throw new Error('上下文读取范围无效');return {id:args.id,sha256:saved.sha256,offset,text:saved.body.slice(offset,offset+limit),nextOffset:offset+limit<saved.body.length?offset+limit:null,characters:saved.body.length};}};
}
export function contextBreakdown(instruction:string,catalog:unknown,value:Record<string,any>){
  const context=value.context??{},history=value.history??[];
  const parts:Record<string,unknown>={system:instruction,instructions:context.instructions??[],memoryIndex:value.memoryIndex,recalled:value.recalledMemories,skills:context.skills??[],tools:catalog,task:{currentTask:value.currentTask,latestUserRequest:value.latestUserRequest,initialRequest:value.initialRequest,taskFeedback:value.taskFeedback},history:history.filter((e:any)=>!['tool_started','tool_result'].includes(e.kind)),toolResults:history.filter((e:any)=>['tool_started','tool_result'].includes(e.kind))};
  const tokens=Object.fromEntries(Object.entries(parts).map(([key,v])=>[key,estimateTokens(v??null)]));
  // JSON 结构、策略、摘要、任务校验和引用等剩余开销统一归入 other，避免漏算。
  const total=estimateTokens(instruction)+estimateTokens(catalog)+estimateTokens(value);
  tokens.other=Math.max(0,total-Object.values(tokens).reduce((a,b)=>a+b,0));
  return {schema:1,estimated:true,estimator:'utf8_bytes_divided_by_3',categories:tokens,usedTokens:Object.values(tokens).reduce((a,b)=>a+b,0),windowTokens:value.contextBudget.windowTokens,targetTokens:value.contextBudget.inputTargetTokens};
}
export function trimHistory(events:ContextEvent[]){return events.filter((e,i)=>!['context_budget','optimization_changed'].includes(e.kind)&&(i>=events.length-8||!['activity','memory_recalled','context_budget','compacted'].includes(e.kind)));}
// 摘要边界不能拆开一次工具执行；启动、期间命令事件与最终结果必须作为完整执行组保留。
export function compactPrefix(events:ContextEvent[],keep=8){
  let end=Math.max(0,events.length-keep);let open=-1;
  for(let i=0;i<end;i++){if(events[i]!.kind==='tool_started')open=i;if(events[i]!.kind==='tool_result')open=-1;}
  if(open>=0)end=open;return end;
}
