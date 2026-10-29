/**
 * 受管命令生命周期 - Windows 环境下命令执行的核心控制逻辑
 *
 * 所属层级：执行层（src/execution/）
 * 核心功能：
 *   - 通过 PowerShell 监督进程启动受管命令，利用 Windows Job Object 实现进程组隔离
 *   - 协议通信：与 C# 监督器通过 stdin/stdout 管道进行结构化消息交换（job|started|out|member|end|error）
 *   - 超时控制：支持启动超时（10 秒）和执行超时（由调用方指定）
 *   - 中止机制：支持 AbortSignal 外部取消，以及内部协议级取消（cancel 指令）
 *   - 身份追踪：记录监督进程 PID、工作进程 PID、启动时间戳和 Job Object 成员列表
 * 依赖关系：
 *   - 调用 [→ 见 src/execution/windows-command.ps1] 作为 PowerShell 监督器入口
 *   - 被 [→ 见 server.mjs] 路由层和 [→ 见 src/coordination/] 协调层调用
 *   - 依赖 [→ 见 src/execution/command-logs.ts] 进行日志持久化
 */
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {StringDecoder} from 'node:string_decoder';
import {resolve} from 'node:path';

/** PowerShell 监督脚本的绝对路径（相对于本文件位置解析） */
const helper=fileURLToPath(new URL('../../../src/execution/windows-command.ps1',import.meta.url));
/** PowerShell 可执行文件路径：优先使用 SystemRoot 环境变量定位，确保不受 PATH 影响 */
const powershell=process.env.SystemRoot?resolve(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'):'powershell.exe';

/**
 * CommandIdentity - 命令的持久化身份信息
 * @property jobName - Windows Job Object 名称（格式：Local\ApiX-Command-<operationId>）
 * @property ownerPid - 监督进程（PowerShell）的 PID
 * @property ownerBirth - 监督进程的启动时间戳（UTC Ticks），用于防止 PID 复用误判
 * @property pid - 实际工作进程的 PID
 * @property birth - 工作进程的启动时间戳
 * @property observedMembers - Job Object 中观测到的成员进程列表（最多保留 20 条）
 */
export interface CommandIdentity {jobName:string;ownerPid?:number;ownerBirth?:string;pid?:number;birth?:string;observedMembers?:{pid:number;name:string}[]}

/**
 * CommandResult - 命令执行结果
 * @property hostResultVersion - 结果协议版本号（当前为 1）
 * @property operationId - 操作唯一标识
 * @property reason - 结束原因：'exit'（正常退出）、'timeout'（超时）、'aborted'（中止）、'startup_timeout'（启动超时）等
 * @property exitCode - 进程退出码（null 表示未获取到）
 * @property output - 合并后的命令输出（已脱敏，最大 12000 字符）
 * @property truncated - 输出是否因超长被截断
 * @property timedOut - 是否因超时结束
 * @property aborted - 是否因外部中止结束
 * @property unknown - 进程是否可能仍在运行（true 表示无法确认所有进程已结束）
 * @property processesEnded - 是否确认所有相关进程已结束
 * @property sideEffectsNeedReview - 是否需要人工检查副作用（命令未正常完成时通常为 true）
 * @property executionComplete - 命令是否完整执行完毕（reason='exit' 且进程全部结束且有退出码）
 * @property identity - 命令身份信息
 * @property evidencePersisted - 日志证据是否已持久化
 * @property error - 错误信息（如有）
 * @property captureError - 输出采集过程中是否发生回调错误
 * @property log - 日志完成摘要（来自 command-logs 的 finish 返回值）
 */
export interface CommandResult {hostResultVersion?:1;operationId:string;startedAt:string;finishedAt:string;reason:string;exitCode:number|null;output:string;truncated:boolean;timedOut:boolean;aborted:boolean;unknown:boolean;processesEnded:boolean;sideEffectsNeedReview:boolean;executionComplete:boolean;identity:CommandIdentity;evidencePersisted?:boolean;error?:string;captureError?:boolean;log?:Record<string,unknown>}

/**
 * CommandHooks - 命令执行过程中的回调钩子
 * @property operationId - 可选的操作 ID（不指定则自动生成 UUID）
 * @property identity - 身份信息可用时的回调（监督进程启动后、工作进程启动后各调用一次）
 * @property output - 输出数据回调（每收到一段 stdout 或 stderr 数据时调用）
 */
export interface CommandHooks {operationId?:string;identity?(identity:CommandIdentity):void;output?(channel:'stdout'|'stderr',text:string):void}

/**
 * inspectCommandSync - 同步检查命令进程组的状态（仅用于快速探测）
 * @param identity - 命令身份信息，必须包含 ownerPid
 * @returns 'ended'（进程已结束）、'active'（仍在运行）或 'unknown'（无法判断）
 * 设计意图：同步版本，超时 6 秒，适用于不允许阻塞事件循环的快速检查场景。
 *   非 Windows 平台直接返回 'unknown'；没有 ownerPid 说明命令从未成功启动，直接返回 'ended'。
 */
export function inspectCommandSync(identity:CommandIdentity):'ended'|'active'|'unknown'{
 if(process.platform!=='win32')return 'unknown';if(!identity.ownerPid)return 'ended';
 const result=spawnSync(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-JobName',identity.jobName,'-Inspect','-OwnerPid',String(identity.ownerPid),'-OwnerBirth',identity.ownerBirth??''],{windowsHide:true,timeout:6000,encoding:'utf8'});
 // 通过监督器输出的协议消息判断状态：inspect|ended 或 inspect|active
 if(result.error||result.status!==0)return 'unknown';return result.stdout.includes('inspect|ended')?'ended':result.stdout.includes('inspect|active')?'active':'unknown';
}

/**
 * inspectCommand - 异步检查命令进程组的状态（支持终止操作）
 * @param identity - 命令身份信息
 * @param terminate - 是否在检查后终止 Job Object 中的所有进程（默认 false）
 * @returns 'ended'（进程已结束）、'active'（仍在运行）或 'unknown'（无法判断）
 * 设计意图：异步版本，超时 5 秒，支持 terminate 参数用于中止命令。
 *   当 terminate=true 时，监督器会尝试终止 Job Object 并等待确认。
 *   输出缓冲限制为最后 2000 字符（防止内存溢出）。
 */
export async function inspectCommand(identity:CommandIdentity,terminate=false):Promise<'ended'|'active'|'unknown'>{
 if(process.platform!=='win32')return 'unknown';
 if(!identity.ownerPid)return 'ended'; // 没有监督进程 PID，说明命令从未成功启动
 return new Promise(resolve=>{
  const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-JobName',identity.jobName,'-Inspect','-OwnerPid',String(identity.ownerPid),'-OwnerBirth',identity.ownerBirth??''];if(terminate)args.push('-Terminate');
  const child=spawn(powershell,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let text='',done=false;
  // finish 是统一的结束处理函数，确保 Promise 只 resolve 一次，同时清理定时器和流
  const finish=(state:'ended'|'active'|'unknown')=>{if(done)return;done=true;clearTimeout(timer);child.stdout.destroy();child.stderr.destroy();resolve(state);};
  // 5 秒超时保护：防止监督器挂起导致 Promise 永远不 resolve
  const timer=setTimeout(()=>{try{child.kill();}catch{}finish('unknown');},5000);
  // 只保留最后 2000 字符的输出（防止极端情况下内存溢出）
  child.stdout.on('data',c=>{text=(text+c).slice(-2000);});child.stderr.resume();child.once('error',()=>finish('unknown'));child.once('close',()=>finish(text.includes('inspect|ended')?'ended':text.includes('inspect|active')?'active':'unknown'));
 });
}

/**
 * managedCommand - 在 Windows Job Object 监督下执行一条外部命令（核心函数）
 *
 * @param executable - 要执行的可执行文件路径
 * @param args - 命令行参数数组
 * @param cwd - 工作目录
 * @param env - 传递给子进程的环境变量
 * @param signal - AbortSignal，用于外部取消命令
 * @param timeoutMs - 命令执行超时（毫秒），0 或负数表示不限制
 * @param onSpawn - 监督进程启动后的回调，接收 ownerPid（用于记录进程身份）
 * @param secrets - 需要脱敏的敏感字符串列表（如 API Key），输出中会被替换为 <redacted>
 * @param hooks - 可选的回调钩子（identity/output 事件通知）
 * @returns Promise<CommandResult> 命令执行结果
 *
 * 安全设计要点：
 * 1. 监督进程使用独立的 Job Object（名称含随机 UUID），确保进程组隔离
 * 2. 监督进程的环境变量使用 process.env（宿主环境），而非 worker 的 env，防止注入
 * 3. 两阶段启动：先启动监督进程 → 等待 job 协议消息 → 发送 'go' 指令 → 监督进程才启动 worker
 * 4. 所有 await 之后都进行 TOCTOU 复查（通过 reason 状态机和 finished 标志）
 * 5. 输出缓冲有 12000 字符上限 + secrets 总长度余量，防止内存溢出
 * 6. 启动超时 10 秒、清理超时 6.5 秒，防止资源泄漏
 */
export async function managedCommand(executable:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,signal:AbortSignal,timeoutMs:number,onSpawn:(pid:number|undefined)=>void,secrets:string[],hooks:CommandHooks={}):Promise<CommandResult>{
 if(process.platform!=='win32')throw new Error('此平台尚无可确认的主 Agent 命令托管实现；未启动命令');
 // operationId 用于唯一标识本次操作，同时作为 Job Object 名称的一部分确保唯一性
 const operationId=hooks.operationId??randomUUID(),identity:CommandIdentity={jobName:'Local\\ApiX-Command-'+operationId};
 const startedAt=new Date().toISOString();
 // 第一阶段：启动 PowerShell 监督进程
 // 注意：此处使用 process.env（宿主环境）而非 worker 的 env，这是安全关键设计——
 // 防止 worker 的 env 中包含的恶意变量影响监督进程的行为
 const child=spawn(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-JobName',identity.jobName],{cwd,env:process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 // safe - 脱敏函数：将文本中所有 secrets 替换为 <redacted>
 const safe=(text:string)=>{for(const s of secrets)text=text.split(s).join('<redacted>');return text;};
 return new Promise(resolve=>{
  // 状态机变量：
  //   reason     - 结束原因（'exit'/'timeout'/'aborted'/'startup_timeout' 等）
  //   exitCode   - 进程退出码
  //   finished   - 是否已完成（防止重复 resolve）
  //   launched   - 监督进程是否已发送 job 消息（即已确认启动）
  //   helperClosed - 监督进程是否已退出
  //   reportedEmpty - 监督进程是否报告了空输出（end 消息中第三个字段为 1）
  //   raw        - 原始输出缓冲（未脱敏）
  //   pending    - 协议行解析的待处理缓冲
  //   truncated  - 输出是否被截断
  //   error      - 错误信息缓冲
  let reason='',exitCode:number|null=null,finished=false,launched=false,helperClosed=false,reportedEmpty=false,probe:Promise<void>|undefined,raw='',pending='',truncated=false,error='';
  // StringDecoder 确保多字节 UTF-8 字符不会在 chunk 边界被切断
  const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
  // 输出缓冲上限：12000 字符 + secrets 总长度（防止脱敏前的缓冲溢出）
  const limit=12000+Math.max(0,...secrets.map(s=>s.length));
  let captureError=false;

  /**
   * output - 处理一段命令输出数据
   * @param chunk - 原始 Buffer 数据
   * @param channel - 来源通道（'stdout' 或 'stderr'）
   * 设计意图：先通知 hooks 回调，再追加到 raw 缓冲；超过 limit 时截断并标记 truncated
   */
  const output=(chunk:Buffer,channel:string)=>{const kind=channel==='stderr'?'stderr':'stdout',text=decoders[kind].write(chunk);try{hooks.output?.(kind,text);}catch{captureError=true;}raw+=text;if(raw.length>limit){truncated=true;raw=raw.slice(0,limit);}};

  /** killHelper - 强制终止监督进程（最后手段） */
  const killHelper=()=>{try{child.kill();}catch(e){error=e instanceof Error?e.message:'终止监督进程失败';}};

  /**
   * finish - 统一的命令结束处理函数
   * @param processesEnded - 是否确认所有相关进程已结束
   * 设计意图：确保 Promise 只 resolve 一次；清理所有定时器、事件监听和流；
   *   刷出 StringDecoder 中残留的字节；计算最终的 executionComplete 和 sideEffectsNeedReview
   */
  const finish=(processesEnded:boolean)=>{
   if(finished)return;finished=true;clearTimeout(startup);clearTimeout(deadline);clearTimeout(cleanup);signal.removeEventListener('abort',abort);
   child.stdout.removeAllListeners('data');child.stderr.removeAllListeners('data');child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();
   // 刷出 StringDecoder 中可能残留的不完整多字节字符
   for(const channel of ['stdout','stderr'] as const){const end=decoders[channel].end();raw+=end;try{hooks.output?.(channel,end);}catch{captureError=true;}}let text=safe(raw);if(text.length>12000)truncated=true;
   // executionComplete：只有正常退出 + 进程全部结束 + 有退出码时才算完整执行
   const executionComplete=reason==='exit'&&processesEnded&&exitCode!==null;
   resolve({hostResultVersion:1,operationId,startedAt,finishedAt:new Date().toISOString(),reason,exitCode,output:text.slice(0,12000),truncated,captureError,timedOut:reason==='timeout',aborted:reason==='aborted',unknown:!processesEnded,processesEnded,sideEffectsNeedReview:!executionComplete&&!(reason==='start_failed'&&!identity.pid),executionComplete,identity:{...identity},...(error?{error:safe(error).slice(0,1000)}:{})});
  };

  // 定时器变量：
  //   startup  - 启动超时定时器（10 秒内未收到 job 消息则判定启动失败）
  //   deadline - 执行超时定时器（由调用方指定的 timeoutMs + 1 秒余量）
  //   cleanup  - 清理超时定时器（发出终止指令后等待监督进程退出的最后期限，6.5 秒）
  let startup:ReturnType<typeof setTimeout>,deadline:ReturnType<typeof setTimeout>|undefined,cleanup:ReturnType<typeof setTimeout>|undefined;

  /**
   * terminate - 发起命令终止流程
   * 设计意图：先尝试协议级取消（向监督进程 stdin 写入 'cancel'），
   *   如果监督进程已退出或未确认启动，则直接 kill 监督进程；
   *   如果已确认启动，则通过 inspectCommand 带 terminate=true 终止 Job Object
   */
  const terminate=()=>{
   if(probe||finished)return;child.stdin.write('cancel\n',()=>{});
   // 如果监督进程还未确认启动（未发送 job 消息），直接 kill 即可
   if(!launched){killHelper();if(helperClosed)finish(true);return;}
   // 已确认启动：通过 inspectCommand 终止 Job Object 中的所有进程
   probe=(async()=>{const state=await inspectCommand(identity,true);if(state!=='ended')killHelper();finish(state==='ended');})();
  };

  /**
   * select - 状态机转换：确定结束原因并启动清理流程
   * @param why - 结束原因（'exit'/'timeout'/'aborted'/'startup_timeout'/'protocol_error' 等）
   * 设计意图：reason 只设置一次（先入为主），防止后续事件覆盖；
   *   设置 reason 后立即清除 startup/deadline 定时器，启动 cleanup 定时器，最后调用 terminate
   */
  const select=(why:string)=>{if(finished||reason)return;reason=why;clearTimeout(startup);clearTimeout(deadline);cleanup=setTimeout(()=>{killHelper();finish(!launched&&helperClosed);},6500);terminate();};
  const abort=()=>select('aborted');
  // 启动超时：10 秒内监督进程必须发送 job 消息确认启动
  startup=setTimeout(()=>select('startup_timeout'),10000);signal.addEventListener('abort',abort,{once:true});
  child.stdin.on('error',()=>{});

  /**
   * 协议消息处理：解析监督进程 stdout 输出的结构化消息
   *
   * 协议格式（每行一条，字段以 '|' 分隔）：
   *   job|<ownerPid>|<ownerBirth>       - 监督进程已启动，报告自身身份
   *   started|<pid>|<birth>             - 工作进程已启动，报告自身身份
   *   out|<channel>|<base64_data>       - 工作进程的一段输出数据
   *   member|<pid>|<base64_name>        - Job Object 中观测到一个成员进程
   *   end|<reason>|<exitCode>|<active>  - 工作进程已结束
   *   error|<base64_message>|<source>   - 监督器发生错误
   */
  child.stdout.on('data',chunk=>{
   if(finished)return;pending+=chunk.toString('utf8');if(pending.length>200000){error='管理协议输出超限';select('protocol_error');return;}
   let at;while((at=pending.indexOf('\n'))>=0){const line=pending.slice(0,at).trim();pending=pending.slice(at+1);const [kind,a,b,c]=line.split('|');
    // out 消息：工作进程的输出数据，channel 为 'stdout' 或 'stderr'，data 为 Base64 编码
    if(kind==='out'){output(Buffer.from(b??'','base64'),a??'stdout');continue;}
    // member 消息：Job Object 中观测到的成员进程（最多保留 20 条，FIFO 淘汰）
    if(kind==='member'){(identity.observedMembers??=[]).push({pid:Number(a),name:Buffer.from(b??'','base64').toString('utf8').slice(0,100)});identity.observedMembers=identity.observedMembers.slice(-20);continue;}
    if(kind==='job'){
     // job 消息：监督进程确认启动，报告自身 PID 和启动时间戳
     identity.ownerPid=Number(a);identity.ownerBirth=b;
     // 如果在等待 job 消息期间已经触发了 select（如 abort），则直接发起 terminate
     if(reason){terminate();continue;}
     try{onSpawn(identity.ownerPid);hooks.identity?.({...identity});}catch(e){error=e instanceof Error?e.message:'启动记录失败';select('record_failed');continue;}
     // 启动确认成功：清除 startup 定时器，标记 launched，发送 'go' 指令让监督进程启动 worker
     clearTimeout(startup);launched=true;child.stdin.write('go\n');
     // 设置执行超时定时器：timeoutMs + 1 秒余量（给监督进程一点清理时间）
     deadline=setTimeout(()=>select('timeout'),timeoutMs+1000);
    }else if(kind==='started'){
     // started 消息：工作进程已启动，报告 PID 和启动时间戳
     identity.pid=Number(a);identity.birth=b;try{hooks.identity?.({...identity});}catch(e){error=e instanceof Error?e.message:'身份记录失败';select('record_failed');}
    }else if(kind==='end'){
     // end 消息：工作进程已结束
     //   a = 原因（'exit' 或 'descendants_remaining'）
     //   b = 退出码（可能为空）
     //   c = 活跃进程数（1 表示只剩监督进程自身，即全部 worker 已退出）
     if(reason)continue;reason=a??'protocol_error';exitCode=b!==''&&b!==undefined?Number(b):null;reportedEmpty=reason==='exit'&&Number(c)===1;
     clearTimeout(deadline);cleanup=setTimeout(()=>{killHelper();finish(false);},6500);
     // reportedEmpty=true 表示监督器报告输出为空且进程全部结束，直接发送 release 让监督进程退出
     // 否则走 terminate 流程（可能需要检查 Job Object 中是否还有残留进程）
     if(reportedEmpty)child.stdin.end('release\n');else terminate();
    }else if(kind==='error'){
     // error 消息：监督器自身发生错误
     //   a = Base64 编码的错误信息
     //   b = 错误来源（'worker' 表示工作进程相关，其他表示启动阶段）
     error=Buffer.from(a??'','base64').toString('utf8');select(b==='worker'?'membership_unknown':'start_failed');
    }
   }
  });
  // 监督进程的 stderr 输出作为错误信息收集（保留最后 2000 字符）
  child.stderr.on('data',chunk=>{error=safe((error+chunk.toString('utf8')).slice(-2000));});
  // 监督进程 spawn 失败（如 PowerShell 不存在）
  child.on('error',e=>{if(finished)return;error=e.message;if(!reason)reason='start_failed';helperClosed=true;finish(!launched);});
  // 监督进程退出：
  //   - 如果 reportedEmpty=true（已正常结束），直接 finish(true)
  //   - 如果尚无 reason，标记 'supervisor_lost'
  //   - 如果已 launched 但尚无 probe，通过 inspectCommand 检查 Job Object 状态
  child.once('close',()=>{helperClosed=true;if(finished)return;if(reportedEmpty){finish(true);return;}if(!reason)reason='supervisor_lost';if(!launched)finish(true);else if(!probe){probe=(async()=>finish(await inspectCommand(identity)==='ended'))();}});
  // 第二阶段：向监督进程发送 JSON 格式的命令配置，启动 worker 进程
  // 配置包含：可执行文件、参数、工作目录、超时、环境变量
  child.stdin.write(JSON.stringify({executable,args,cwd,timeoutMs,env})+'\n');if(signal.aborted)abort();
 });
}
