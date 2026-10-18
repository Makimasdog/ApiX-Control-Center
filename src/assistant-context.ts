import {createHash,randomUUID} from 'node:crypto';
import type {Store} from './contracts.js';

export interface ContextEvent {id:number;role:string;kind:string;body:string}
export const estimateTokens=(value:unknown)=>Math.ceil(Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value),'utf8')/3);
export function contextWindow(value:unknown){const n=Number(value??32768);if(!Number.isSafeInteger(n)||n<4096||n>1000000)throw new Error('上下文窗口应为 4096–1000000 Token');return n;}
export function createContextOutputs(store:Store){
  const {db,row,rows,now}=store;
  db.exec('CREATE TABLE IF NOT EXISTS assistant_outputs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES assistant_sessions(id),event_id INTEGER NOT NULL,body TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS assistant_output_event ON assistant_outputs(session_id,event_id)');
  function history(sessionId:string,events:ContextEvent[]){return events.map(e=>{
    const body=JSON.parse(e.body);if(!['tool_started','tool_result','delegation_result','supervision_event'].includes(e.kind)||e.body.length<=8000||body.tool==='read_context')return {...e,body};
    let saved=row<{id:string;sha256:string}>('SELECT id,sha256 FROM assistant_outputs WHERE session_id=? AND event_id=?',sessionId,e.id);
    if(!saved){const id=randomUUID(),sha256=createHash('sha256').update(e.body).digest('hex');db.prepare('INSERT INTO assistant_outputs VALUES (?,?,?,?,?,?)').run(id,sessionId,e.id,e.body,sha256,now());saved={id,sha256};}
    const result=body.result??body;const flags=Object.fromEntries(['exitCode','fingerprint','truncated','timedOut','aborted','unknown','isError'].filter(k=>result&&typeof result==='object'&&k in result).map(k=>[k,result[k]]));
    const reference={...flags,outputRef:saved.id,sha256:saved.sha256,characters:e.body.length,preview:e.body.slice(0,1200),fullResultAvailable:true};
    return {...e,body:e.kind==='tool_started'?{tool:body.tool,args:{path:body.args?.path,executable:body.args?.executable,...reference}}:{tool:body.tool,ok:body.ok,result:reference}};
  });}
  return {history,index:(sessionId:string)=>rows('SELECT id,event_id,sha256,length(body) AS characters FROM assistant_outputs WHERE session_id=? ORDER BY event_id DESC LIMIT 20',sessionId),read(sessionId:string,args:Record<string,unknown>){const saved=row<{body:string;sha256:string}>('SELECT body,sha256 FROM assistant_outputs WHERE id=? AND session_id=?',String(args.id),sessionId);if(!saved)throw new Error('上下文引用不存在或不属于本会话');const offset=Number(args.offset??0),limit=Number(args.limit??4000);if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>6000)throw new Error('上下文读取范围无效');return {id:args.id,sha256:saved.sha256,offset,text:saved.body.slice(offset,offset+limit),nextOffset:offset+limit<saved.body.length?offset+limit:null,characters:saved.body.length};}};
}
// Keep an entire host tool execution, including intervening command events, together.
export function compactPrefix(events:ContextEvent[],keep=8){
  let end=Math.max(0,events.length-keep);let open=-1;
  for(let i=0;i<end;i++){if(events[i]!.kind==='tool_started')open=i;if(events[i]!.kind==='tool_result')open=-1;}
  if(open>=0)end=open;return end;
}
