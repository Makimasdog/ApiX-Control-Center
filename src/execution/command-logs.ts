import {createHash} from 'node:crypto';
import type {Store} from '../coordination/contracts.js';

export const logLimits={perOperationBytes:256*1024,totalBytes:8*1024*1024,tailBytes:8192,retentionDays:7};
type Channel='stdout'|'stderr';
interface LogData {kind:'command_log_v1';operationId:string;channel:Channel;head:string;tail:string;complete:boolean;state:string;reason:string|null;observedBytes:number;capturedBytes:number;createdAt:string}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function prefix(text:string,bytes:number){let data=Buffer.from(text).subarray(0,Math.max(0,bytes));while(data.length){try{new TextDecoder('utf-8',{fatal:true}).decode(data);break;}catch{data=data.subarray(0,data.length-1);}}return data.toString('utf8');}
function tail(text:string){const data=Buffer.from(text);let start=Math.max(0,data.length-logLimits.tailBytes);while(start<data.length&&(data[start]!&0xc0)===0x80)start++;return data.subarray(start).toString('utf8');}
export function createCommandLogs(store:Store){
 const {db,row,rows,now}=store,active=new Set<string>();
 const event=(session:string,kind:string,body:unknown)=>db.prepare("INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,'system',?,?,?)").run(session,kind,JSON.stringify(body),now());
 const all=()=>rows<{id:string;session_id:string;body:string;created_at:string}>('SELECT id,session_id,body,created_at FROM assistant_outputs WHERE id LIKE \'log-%\' ORDER BY created_at,event_id');
 const usage=()=>row<{bytes:number}>('SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) bytes FROM assistant_outputs WHERE id LIKE \'log-%\'')!.bytes;
 function collect(){
  let used=usage();const cutoff=Date.parse(now())-logLimits.retentionDays*86400000;const groups=new Map<string,ReturnType<typeof all>>();for(const r of all()){const op=JSON.parse(r.body).operationId;groups.set(op,[...(groups.get(op)??[]),r]);}
  for(const [op,records] of groups){if(active.has(op))continue;if(Date.parse(records[0]!.created_at)<cutoff||used+2*1024*1024>logLimits.totalBytes){for(const r of records){db.prepare('DELETE FROM assistant_outputs WHERE id=?').run(r.id);used-=Buffer.byteLength(r.body);}event(records[0]!.session_id,'command_log_expired',{operationId:op,reason:Date.parse(records[0]!.created_at)<cutoff?'retention':'total_capacity'});}}
 }
 function start(sessionId:string,operationId:string,secrets:string[]){
  let failed:string|null=null,captured=0;const pending={stdout:'',stderr:''},refs={stdout:'log-'+operationId+'-stdout',stderr:'log-'+operationId+'-stderr'},data={} as Record<Channel,LogData>;
  const safe=(text:string)=>{for(const secret of [...secrets].filter(Boolean).sort((a,b)=>b.length-a.length))text=text.split(secret).join('<redacted>');return text;};
  const hold=Math.max(1,...secrets.map(s=>s.length));active.add(operationId);
  try{collect();}catch{failed='retention_cleanup_failed';}
  for(const channel of ['stdout','stderr'] as const){data[channel]={kind:'command_log_v1',operationId,channel,head:'',tail:'',complete:false,state:'recording',reason:null,observedBytes:0,capturedBytes:0,createdAt:now()};try{const anchor=event(sessionId,'command_log_anchor',{operationId,channel});const body=JSON.stringify(data[channel]);db.prepare('INSERT INTO assistant_outputs VALUES (?,?,?,?,?,?)').run(refs[channel],sessionId,Number(anchor.lastInsertRowid),body,sha(body),now());}catch{failed='log_initialization_failed';}}
  function persist(channel:Channel){const body=JSON.stringify(data[channel]);try{const existing=row<{bytes:number}>('SELECT length(CAST(body AS BLOB)) bytes FROM assistant_outputs WHERE id=? AND session_id=?',refs[channel],sessionId);if(!existing)throw new Error('missing log artifact');if(usage()-existing.bytes+Buffer.byteLength(body)>logLimits.totalBytes){failed='total_capacity';return;}const result=db.prepare('UPDATE assistant_outputs SET body=?,sha256=? WHERE id=? AND session_id=?').run(body,sha(body),refs[channel],sessionId);if(result.changes!==1)throw new Error('missing log artifact');}catch{failed='log_write_failed';}}
  function emit(channel:Channel,text:string){if(!text)return;const d=data[channel],bytes=Buffer.byteLength(text);d.tail=tail(d.tail+text);const part=prefix(text,logLimits.perOperationBytes-captured);d.head+=part;captured+=Buffer.byteLength(part);d.capturedBytes+=Buffer.byteLength(part);if(Buffer.byteLength(part)<bytes)failed??='operation_capacity';if(part)persist(channel);}
  function flush(channel:Channel,final=false){const text=pending[channel];let cut=final?text.length:Math.max(0,text.length-hold+1);for(const secret of secrets){if(!secret)continue;let index=text.indexOf(secret);while(index>=0){if(index<cut&&index+secret.length>cut)cut=index;index=text.indexOf(secret,index+1);}}emit(channel,safe(text.slice(0,cut)));pending[channel]=text.slice(cut);}
  return {
   write(channel:Channel,text:string){data[channel].observedBytes+=Buffer.byteLength(text);pending[channel]+=text;flush(channel);},
   finish(captureError=false){for(const channel of ['stdout','stderr'] as const)flush(channel,true);if(captureError)failed??='collector_callback_failed';for(const channel of ['stdout','stderr'] as const){data[channel].complete=failed===null;data[channel].state='finished';data[channel].reason=failed;persist(channel);}if(failed)for(const channel of ['stdout','stderr'] as const){data[channel].complete=false;data[channel].reason=failed;persist(channel);}active.delete(operationId);return {version:1,operationId,complete:failed===null,status:failed?'incomplete':'complete',reason:failed,capturedBytes:captured,observedBytes:data.stdout.observedBytes+data.stderr.observedBytes,limitBytes:logLimits.perOperationBytes,tailBytes:logLimits.tailBytes,retentionDays:logLimits.retentionDays,stdoutRef:refs.stdout,stderrRef:refs.stderr};}
  };
 }
 function read(sessionId:string,args:Record<string,unknown>){
  let operationId=args.operationId;if(args.outputRef!==undefined){const saved=row<{body:string}>('SELECT body FROM assistant_outputs WHERE id=? AND session_id=?',String(args.outputRef),sessionId);if(!saved)throw new Error('日志引用不存在或不属于本会话');const value=JSON.parse(saved.body);operationId=value.operationId??value.result?.operationId;}
  if(typeof operationId!=='string'||!row("SELECT id FROM assistant_events WHERE session_id=? AND kind='command_intent' AND json_extract(body,'$.operationId')=?",sessionId,operationId))throw new Error('操作不存在或不属于本会话');
  const channel=args.channel??'stdout';if(!['stdout','stderr'].includes(String(channel)))throw new Error('日志通道无效');const mode=args.mode??'head';if(!['head','tail'].includes(String(mode)))throw new Error('日志读取模式无效');const offset=Number(args.offset??0),limit=Number(args.limit??6000);if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>6000)throw new Error('日志读取范围无效');
  const saved=row<{body:string;sha256:string;created_at:string}>("SELECT body,sha256,created_at FROM assistant_outputs WHERE session_id=? AND id=?",sessionId,'log-'+operationId+'-'+String(channel));
  if(!saved||Date.parse(saved.created_at)<Date.parse(now())-logLimits.retentionDays*86400000)return {operationId,channel,mode,text:'',nextOffset:null,complete:false,status:'expired_or_unavailable',reason:'retention_capacity_or_capture_unavailable',gap:true};
  if(sha(saved.body)!==saved.sha256)return {operationId,channel,mode,text:'',nextOffset:null,complete:false,status:'integrity_error',reason:'log_digest_mismatch',gap:true};
  const d=JSON.parse(saved.body) as LogData;const terminal=row<{body:string}>("SELECT body FROM assistant_events WHERE session_id=? AND kind='command_finished' AND json_extract(body,'$.operationId')=? ORDER BY id DESC LIMIT 1",sessionId,operationId);const finalLog=terminal?JSON.parse(terminal.body).log:null;if(finalLog?.complete===false){d.complete=false;d.reason=finalLog.reason;d.state='finished';}const text=mode==='tail'?d.tail:d.head;let start=mode==='tail'?Math.max(0,text.length-offset-limit):offset,end=mode==='tail'?Math.max(0,text.length-offset):Math.min(text.length,offset+limit);
  const low=(at:number)=>{const n=text.charCodeAt(at);return n>=0xdc00&&n<=0xdfff;};
  if(mode==='tail'){if(end<text.length&&low(end))throw new Error('日志偏移必须位于完整字符边界');if(low(start))start++;}else{if(low(start))throw new Error('日志偏移必须位于完整字符边界');if(end<text.length&&low(end))end--;}
  if(start>=end&&offset<text.length)throw new Error('日志页预算不足以读取一个完整字符');
  return {operationId,channel,mode,text:text.slice(start,end),offset,offsetUnit:mode==='tail'?'utf16_characters_from_end':'utf16_characters',nextOffset:mode==='tail'?(start>0?text.length-start:null):(end<text.length?end:null),characters:text.length,complete:d.complete,status:d.state==='recording'?'recording':d.complete?'complete':'incomplete',reason:d.reason,observedBytes:d.observedBytes,capturedBytes:d.capturedBytes,gap:!d.complete,sha256:saved.sha256};
 }
 return {start,read,collect};
}
