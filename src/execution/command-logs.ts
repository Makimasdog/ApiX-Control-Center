/**
 * 命令日志持久化 - 管理受管命令执行过程中的输出日志存储
 *
 * 所属层级：执行层（src/execution/）
 * 核心功能：
 *   - head/tail 双缓冲：head 记录开头 N 字节，tail 记录结尾 N 字节，兼顾完整性和可追溯性
 *   - 密钥脱敏（secrets redaction）：将日志中出现的敏感信息替换为 <redacted>
 *   - SHA-256 完整性校验：每次写入计算摘要，读取时验证，防止日志被篡改
 *   - 容量/时间回收：按保留天数（7 天）和总容量上限（8MB）自动清理过期日志
 * 依赖关系：
 *   - 被 [→ 见 src/execution/command-lifecycle.ts] 调用，在命令执行期间写入日志
 *   - 依赖 [→ 见 src/coordination/contracts.ts] 中的 Store 接口访问 SQLite 数据库
 *   - 操作 assistant_outputs 表（存储日志正文）和 assistant_events 表（存储审计事件）
 */
import {createHash} from 'node:crypto';
import type {Store} from '../coordination/contracts.js';

/** 日志容量限制常量 */
export const logLimits={
 perOperationBytes:256*1024,  // 单次操作最大捕获 256KB
 totalBytes:8*1024*1024,      // 所有日志总容量上限 8MB
 tailBytes:8192,              // tail 缓冲区大小 8KB（保留日志末尾）
 retentionDays:7              // 日志保留天数
};

/** 日志通道类型：标准输出或标准错误 */
type Channel='stdout'|'stderr';

/**
 * LogData - 单条日志的完整数据结构
 * @property head - 日志开头部分（受 perOperationBytes 限制）
 * @property tail - 日志结尾部分（受 tailBytes 限制）
 * @property observedBytes - 实际观测到的总字节数（可能大于 capturedBytes）
 * @property capturedBytes - 实际捕获的字节数
 * @property complete - 日志是否完整捕获（false 表示因容量限制截断）
 */
interface LogData {kind:'command_log_v1';operationId:string;channel:Channel;head:string;tail:string;complete:boolean;state:string;reason:string|null;observedBytes:number;capturedBytes:number;createdAt:string}

/** sha - 计算字符串的 SHA-256 摘要（十六进制），用于日志完整性校验 */
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');

/**
 * prefix - 截取文本的前 N 个字节，确保在 UTF-8 字符边界处截断
 * @param text - 原始文本
 * @param bytes - 最大字节数
 * @returns 截断后的 UTF-8 字符串
 * 设计意图：直接按字节截断可能切断多字节字符，此函数从截断点向前回退，
 *   直到找到一个合法的 UTF-8 字符起始位置
 */
function prefix(text:string,bytes:number){let data=Buffer.from(text).subarray(0,Math.max(0,bytes));while(data.length){try{new TextDecoder('utf-8',{fatal:true}).decode(data);break;}catch{data=data.subarray(0,data.length-1);}}return data.toString('utf8');}

/**
 * tail - 截取文本的末尾 N 个字节，确保在 UTF-8 字符边界处截断
 * @param text - 原始文本
 * @returns 末尾部分的 UTF-8 字符串
 * 设计意图：UTF-8 续字节的形式为 10xxxxxx（即 (byte & 0xc0) === 0x80），
 *   从截断起点向后跳过所有续字节，找到下一个字符的起始位置
 */
function tail(text:string){const data=Buffer.from(text);let start=Math.max(0,data.length-logLimits.tailBytes);while(start<data.length&&(data[start]!&0xc0)===0x80)start++;return data.subarray(start).toString('utf8');}

/**
 * createCommandLogs - 创建命令日志管理器实例
 * @param store - 数据库 Store 对象，提供 db/row/rows/now 等基础方法
 * @returns 包含 start（开始记录）、read（读取日志）、collect（回收清理）三个方法的对象
 */
export function createCommandLogs(store:Store){
 const {db,row,rows,now}=store,active=new Set<string>();

 /**
  * event - 向 assistant_events 表写入一条系统事件
  * @param session - 会话 ID
  * @param kind - 事件类型（如 command_log_anchor、command_log_expired 等）
  * @param body - 事件内容（会被 JSON 序列化）
  */
 const event=(session:string,kind:string,body:unknown)=>db.prepare("INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,'system',?,?,?)").run(session,kind,JSON.stringify(body),now());

 /** all - 查询所有日志类型的 assistant_outputs 记录，按创建时间排序 */
 const all=()=>rows<{id:string;session_id:string;body:string;created_at:string}>('SELECT id,session_id,body,created_at FROM assistant_outputs WHERE id LIKE \'log-%\' ORDER BY created_at,event_id');

 /** usage - 计算当前所有日志占用的总字节数 */
 const usage=()=>row<{bytes:number}>('SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) bytes FROM assistant_outputs WHERE id LIKE \'log-%\'')!.bytes;

 /**
  * collect - 日志回收：按时间和容量两个维度清理过期日志
  * 设计意图：
  *   - 时间维度：超过 retentionDays（7 天）的日志自动删除
  *   - 容量维度：当总容量接近 totalBytes（8MB）时，即使未过期也删除最旧的日志
  *   - 按 operationId 分组删除，确保同一操作的 stdout/stderr 日志一起清理
  *   - 正在活跃的操作（active Set 中）不会被回收
  */
 function collect(){
  let used=usage();const cutoff=Date.parse(now())-logLimits.retentionDays*86400000;const groups=new Map<string,ReturnType<typeof all>>();for(const r of all()){const op=JSON.parse(r.body).operationId;groups.set(op,[...(groups.get(op)??[]),r]);}
  for(const [op,records] of groups){if(active.has(op))continue;if(Date.parse(records[0]!.created_at)<cutoff||used+2*1024*1024>logLimits.totalBytes){for(const r of records){db.prepare('DELETE FROM assistant_outputs WHERE id=?').run(r.id);used-=Buffer.byteLength(r.body);}event(records[0]!.session_id,'command_log_expired',{operationId:op,reason:Date.parse(records[0]!.created_at)<cutoff?'retention':'total_capacity'});}}
 }

 /**
  * start - 开始记录一次命令执行的日志
  * @param sessionId - 所属会话 ID
  * @param operationId - 操作唯一标识（与 command-lifecycle 中的 operationId 对应）
  * @param secrets - 需要脱敏的敏感字符串列表（如 API Key）
  * @returns 包含 write（写入输出）和 finish（完成记录）方法的日志句柄
  * 设计意图：
  *   - 为 stdout 和 stderr 各创建一条独立的日志记录（refs.stdout / refs.stderr）
  *   - 先写入 anchor 事件建立关联，再插入初始日志正文（含 SHA-256 摘要）
  *   - 启动前调用 collect() 尝试回收旧日志，释放空间
  */
 function start(sessionId:string,operationId:string,secrets:string[]){
  let failed:string|null=null,captured=0;const pending={stdout:'',stderr:''},refs={stdout:'log-'+operationId+'-stdout',stderr:'log-'+operationId+'-stderr'},data={} as Record<Channel,LogData>;
  /** safe - 将文本中的所有敏感信息替换为 <redacted>，按长度降序匹配防止部分替换 */
  const safe=(text:string)=>{for(const secret of [...secrets].filter(Boolean).sort((a,b)=>b.length-a.length))text=text.split(secret).join('<redacted>');return text;};
  // hold 是密钥最大长度，用于在 flush 时预留缓冲，防止密钥被截断到 head/tail 之间
  const hold=Math.max(1,...secrets.map(s=>s.length));active.add(operationId);
  try{collect();}catch{failed='retention_cleanup_failed';}
  // 为 stdout 和 stderr 各初始化一条日志记录
  for(const channel of ['stdout','stderr'] as const){data[channel]={kind:'command_log_v1',operationId,channel,head:'',tail:'',complete:false,state:'recording',reason:null,observedBytes:0,capturedBytes:0,createdAt:now()};try{const anchor=event(sessionId,'command_log_anchor',{operationId,channel});const body=JSON.stringify(data[channel]);db.prepare('INSERT INTO assistant_outputs VALUES (?,?,?,?,?,?)').run(refs[channel],sessionId,Number(anchor.lastInsertRowid),body,sha(body),now());}catch{failed='log_initialization_failed';}}

  /**
   * persist - 将指定通道的日志数据持久化到数据库
   * @param channel - 通道名称（stdout 或 stderr）
   * 设计意图：先检查剩余容量是否足够，再执行 UPDATE；同时更新 SHA-256 摘要
   */
  function persist(channel:Channel){const body=JSON.stringify(data[channel]);try{const existing=row<{bytes:number}>('SELECT length(CAST(body AS BLOB)) bytes FROM assistant_outputs WHERE id=? AND session_id=?',refs[channel],sessionId);if(!existing)throw new Error('missing log artifact');if(usage()-existing.bytes+Buffer.byteLength(body)>logLimits.totalBytes){failed='total_capacity';return;}const result=db.prepare('UPDATE assistant_outputs SET body=?,sha256=? WHERE id=? AND session_id=?').run(body,sha(body),refs[channel],sessionId);if(result.changes!==1)throw new Error('missing log artifact');}catch{failed='log_write_failed';}}

  /**
   * emit - 将一段文本追加到日志的 head 和 tail 缓冲区
   * @param channel - 通道名称
   * @param text - 待写入的文本（已经过脱敏处理）
   * 设计意图：head 只保留前 perOperationBytes 字节，tail 始终保留最后 tailBytes 字节
   */
  function emit(channel:Channel,text:string){if(!text)return;const d=data[channel],bytes=Buffer.byteLength(text);d.tail=tail(d.tail+text);const part=prefix(text,logLimits.perOperationBytes-captured);d.head+=part;captured+=Buffer.byteLength(part);d.capturedBytes+=Buffer.byteLength(part);if(Buffer.byteLength(part)<bytes)failed??='operation_capacity';if(part)persist(channel);}

  /**
   * flush - 将 pending 缓冲区中的文本刷出到日志
   * @param channel - 通道名称
   * @param final - 是否为最终刷出（finish 时调用）
   * 设计意图：安全关键——在密钥边界处截断，防止密钥明文泄漏到日志中。
   *   cut 指针会从后向前扫描，确保所有密钥完整落入"不写入"区域
   */
  function flush(channel:Channel,final=false){const text=pending[channel];let cut=final?text.length:Math.max(0,text.length-hold+1);for(const secret of secrets){if(!secret)continue;let index=text.indexOf(secret);while(index>=0){if(index<cut&&index+secret.length>cut)cut=index;index=text.indexOf(secret,index+1);}}emit(channel,safe(text.slice(0,cut)));pending[channel]=text.slice(cut);}

  return {
   /** write - 外部调用：写入一段命令输出 */
   write(channel:Channel,text:string){data[channel].observedBytes+=Buffer.byteLength(text);pending[channel]+=text;flush(channel);},
   /**
    * finish - 外部调用：命令执行完毕，刷出剩余缓冲并标记日志完成状态
    * @param captureError - 是否存在采集器回调错误
    * @returns 日志完成摘要，包含捕获字节数、状态、引用 ID 等信息
    */
   finish(captureError=false){for(const channel of ['stdout','stderr'] as const)flush(channel,true);if(captureError)failed??='collector_callback_failed';for(const channel of ['stdout','stderr'] as const){data[channel].complete=failed===null;data[channel].state='finished';data[channel].reason=failed;persist(channel);}if(failed)for(const channel of ['stdout','stderr'] as const){data[channel].complete=false;data[channel].reason=failed;persist(channel);}active.delete(operationId);return {version:1,operationId,complete:failed===null,status:failed?'incomplete':'complete',reason:failed,capturedBytes:captured,observedBytes:data.stdout.observedBytes+data.stderr.observedBytes,limitBytes:logLimits.perOperationBytes,tailBytes:logLimits.tailBytes,retentionDays:logLimits.retentionDays,stdoutRef:refs.stdout,stderrRef:refs.stderr};}
  };
 }

 /**
  * read - 读取指定操作的命令日志
  * @param sessionId - 会话 ID（用于权限隔离，只能读取本会话的日志）
  * @param args - 查询参数对象：
  *   - operationId: 操作 ID（或通过 outputRef 引用间接获取）
  *   - channel: 'stdout' | 'stderr'（默认 stdout）
  *   - mode: 'head' | 'tail'（默认 head）
  *   - offset: 偏移量（默认 0）
  *   - limit: 每次读取的最大字符数（默认 6000，上限 6000）
  * @returns 日志内容对象，包含 text、offset、nextOffset、complete、status、sha256 等字段
  * 安全设计：
  *   - 权限隔离：通过 command_intent 事件验证操作确实属于本会话
  *   - 完整性校验：读取后比对 SHA-256 摘要，检测日志是否被篡改
  *   - UTF-16 边界对齐：offset/limit 按 UTF-16 代码单元计算，避免切断代理对（surrogate pair）
  */
 function read(sessionId:string,args:Record<string,unknown>){
  // 解析 operationId：可以直接传，也可以通过 outputRef（日志引用 ID）间接获取
  let operationId=args.operationId;if(args.outputRef!==undefined){const saved=row<{body:string}>('SELECT body FROM assistant_outputs WHERE id=? AND session_id=?',String(args.outputRef),sessionId);if(!saved)throw new Error('日志引用不存在或不属于本会话');const value=JSON.parse(saved.body);operationId=value.operationId??value.result?.operationId;}
  // 权限校验：确保该操作确实属于当前会话（通过 command_intent 事件关联）
  if(typeof operationId!=='string'||!row("SELECT id FROM assistant_events WHERE session_id=? AND kind='command_intent' AND json_extract(body,'$.operationId')=?",sessionId,operationId))throw new Error('操作不存在或不属于本会话');
  // 参数校验：channel、mode、offset、limit 都有严格的类型和范围限制
  const channel=args.channel??'stdout';if(!['stdout','stderr'].includes(String(channel)))throw new Error('日志通道无效');const mode=args.mode??'head';if(!['head','tail'].includes(String(mode)))throw new Error('日志读取模式无效');const offset=Number(args.offset??0),limit=Number(args.limit??6000);if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>6000)throw new Error('日志读取范围无效');
  // 从数据库读取日志正文和 SHA-256 摘要
  const saved=row<{body:string;sha256:string;created_at:string}>("SELECT body,sha256,created_at FROM assistant_outputs WHERE session_id=? AND id=?",sessionId,'log-'+operationId+'-'+String(channel));
  // 过期或不存在：返回带 gap=true 的空结果，告知调用方日志已不可用
  if(!saved||Date.parse(saved.created_at)<Date.parse(now())-logLimits.retentionDays*86400000)return {operationId,channel,mode,text:'',nextOffset:null,complete:false,status:'expired_or_unavailable',reason:'retention_capacity_or_capture_unavailable',gap:true};
  // 完整性校验：比对 SHA-256 摘要，不一致说明日志可能被篡改
  if(sha(saved.body)!==saved.sha256)return {operationId,channel,mode,text:'',nextOffset:null,complete:false,status:'integrity_error',reason:'log_digest_mismatch',gap:true};
  // 解析日志数据，检查是否有未完成的最终状态（command_finished 事件中的 complete=false 覆盖）
  const d=JSON.parse(saved.body) as LogData;const terminal=row<{body:string}>("SELECT body FROM assistant_events WHERE session_id=? AND kind='command_finished' AND json_extract(body,'$.operationId')=? ORDER BY id DESC LIMIT 1",sessionId,operationId);const finalLog=terminal?JSON.parse(terminal.body).log:null;if(finalLog?.complete===false){d.complete=false;d.reason=finalLog.reason;d.state='finished';}const text=mode==='tail'?d.tail:d.head;let start=mode==='tail'?Math.max(0,text.length-offset-limit):offset,end=mode==='tail'?Math.max(0,text.length-offset):Math.min(text.length,offset+limit);
  // UTF-16 代理对边界检测辅助函数：判断指定位置是否为低代理项（surrogate 后半部分）
  const low=(at:number)=>{const n=text.charCodeAt(at);return n>=0xdc00&&n<=0xdfff;};
  // 确保读取范围在完整的 UTF-16 字符边界上，避免切断代理对
  if(mode==='tail'){if(end<text.length&&low(end))throw new Error('日志偏移必须位于完整字符边界');if(low(start))start++;}else{if(low(start))throw new Error('日志偏移必须位于完整字符边界');if(end<text.length&&low(end))end--;}
  if(start>=end&&offset<text.length)throw new Error('日志页预算不足以读取一个完整字符');
  return {operationId,channel,mode,text:text.slice(start,end),offset,offsetUnit:mode==='tail'?'utf16_characters_from_end':'utf16_characters',nextOffset:mode==='tail'?(start>0?text.length-start:null):(end<text.length?end:null),characters:text.length,complete:d.complete,status:d.state==='recording'?'recording':d.complete?'complete':'incomplete',reason:d.reason,observedBytes:d.observedBytes,capturedBytes:d.capturedBytes,gap:!d.complete,sha256:saved.sha256};
 }
 return {start,read,collect};
}
