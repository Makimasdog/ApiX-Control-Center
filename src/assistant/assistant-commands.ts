/**
 * assistant-commands.ts - 助手命令系统：管理命令的安全执行、状态追踪与故障恢复
 *
 * 所属层级：助手层 - 命令系统
 * 核心功能：
 *   1. 命令执行前的安全检查（assertClear）——确保无未核对的副作用
 *   2. 命令的完整生命周期管理：意图记录 → 执行 → 终态持久化
 *   3. 故障恢复（recover）——验证受管进程已结束后解除项目阻塞
 *   4. 敏感信息脱敏（safe）——日志和错误信息中自动遮蔽密钥
 * 依赖关系：
 *   - 被助手主循环调用，处理 run_command / verify 等工具
 *   - 依赖 [→ 见 src/execution/command-lifecycle.ts] 进行命令进程管理
 *   - 依赖 [→ 见 src/execution/command-logs.ts] 持久化命令输出日志
 *   - 依赖 [→ 见 src/recovery/fault-policy.ts] 提供 PreflightError
 */
import {PreflightError} from '../recovery/fault-policy.js';
import {randomUUID,createHash} from 'node:crypto';
import {commandTool,preflightCommand,projectFingerprint} from './assistant-tools.js';
import {inspectCommandSync,type CommandIdentity,type CommandResult} from '../execution/command-lifecycle.js';
import {type Store,type Policy} from '../coordination/contracts.js';
import {createCommandLogs} from '../execution/command-logs.js';

/** 命令安全错误——当命令生命周期出现不可信状态时抛出，阻止后续操作 */
export class CommandSafetyError extends Error {readonly code='COMMAND_LIFECYCLE_UNKNOWN';constructor(message:string,readonly operationId?:string,readonly resource:'command_operation'|'file_operation'='command_operation'){super(message);}}
interface Session {id:string;project_id:string}
/** 依赖注入接口：扩展 Store 增加项目路径、环境变量、策略等能力 */
interface Dependencies extends Store {root(projectId:string):string;env():NodeJS.ProcessEnv;protectedValues():string[];policy(projectId:string):Policy}

/**
 * 创建助手命令管理器
 * @param deps - 依赖注入，包含数据库、项目路径、环境变量、安全策略等
 * @returns 包含 execute / assertClear / recover / readOutput 四个方法的命令管理器
 */
export function createAssistantCommands(deps:Dependencies){
 const {db,row,rows,now}=deps,inFlight=new Set<string>(),blocked=new Set<string>(),logs=createCommandLogs(deps);

 /**
  * safe - 将错误信息中的敏感内容（密钥、令牌等）替换为 <redacted>
  * @param error - 原始错误对象
  * @returns 脱敏后的安全文本（最多 1000 字符）
  */
 const safe=(error:unknown)=>{let text=error instanceof Error?error.message:'命令记录失败';for(const secret of [...deps.protectedValues(),...Object.entries({...process.env,...deps.env()}).filter(([key,value])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(key)&&value&&value.length>=6).map(([,value])=>value!)])if(secret)text=text.split(secret).join('<redacted>');return text.slice(0,1000);};

 /**
  * event - 向 assistant_events 表写入一条系统事件记录
  * @param id - 会话 ID
  * @param kind - 事件类型（如 command_intent、command_finished 等）
  * @param body - 事件内容，会被 JSON 序列化存储
  */
 const event=(id:string,kind:string,body:unknown)=>db.prepare("INSERT INTO assistant_events(session_id,role,kind,body,created_at) VALUES (?,'system',?,?,?)").run(id,kind,JSON.stringify(body),now());

 /**
  * pending - 查找指定项目中尚未核对完成的命令操作
  * 通过回溯 command_intent / command_identity / command_finished / resumed 事件，
  * 筛选出已执行但未确认（进程未结束或副作用待审查）的操作。
  * @param projectId - 项目 ID
  * @returns 待核对操作列表 [operationId, 操作详情]
  */
 function pending(projectId:string){
  const events=rows<{id:number;session_id:string;kind:string;body:string}>("SELECT e.* FROM assistant_events e JOIN assistant_sessions s ON s.id=e.session_id WHERE s.project_id=? AND e.kind IN ('command_intent','command_identity','command_finished','resumed') ORDER BY e.id",projectId);
  const operations=new Map<string,{id:number;sessionId:string;identity:CommandIdentity;result?:CommandResult}>(),resumed=new Map<string,number>();
  // 逐事件解析：resumed 标记会话恢复点，command_intent 记录执行意图，
  // command_identity 补充进程身份，command_finished 记录终态结果
  for(const e of events){const body=JSON.parse(e.body);if(e.kind==='resumed'){resumed.set(e.session_id,e.id);continue;}if(e.kind==='command_intent')operations.set(body.operationId,{id:e.id,sessionId:e.session_id,identity:body.identity});else{const op=operations.get(body.operationId);if(op){op.id=e.id;if(e.kind==='command_identity')op.identity=body.identity;else op.result=body;}}}
  // 过滤条件：排除已正常结束且无副作用待审、证据已持久化的操作；
  // 同时排除在 resumed 之前已完成的操作（恢复后不再追究）
  return [...operations.entries()].filter(([,op])=>!(op.result?.processesEnded&&!op.result.sideEffectsNeedReview&&op.result.evidencePersisted)&&((resumed.get(op.sessionId)??0)<=op.id));
 }

 /**
  * assertClear - 断言当前项目没有未核对的命令副作用
  * 在发送普通消息前调用，防止命令副作用被静默忽略。
  * @param s - 当前会话
  * @param ownOnly - 若为 true，只检查本会话的命令（默认为 false，检查所有）
  */
 function assertClear(s:Session,ownOnly=false){
  if(blocked.has(s.project_id)||pending(s.project_id).some(([,op])=>!ownOnly||op.sessionId===s.id))throw new Error('本项目有命令或副作用尚未核对；普通消息不会重放，请检查后恢复');
 }

 /**
  * recover - 恢复被阻塞的项目：验证所有待核对命令的进程已结束，然后解除阻塞
  * @param s - 当前会话
  */
 function recover(s:Session){
  for(const [id,op] of pending(s.project_id).filter(([,op])=>op.sessionId===s.id)){
   if(inFlight.has(id))throw new CommandSafetyError('命令仍在收尾，不能确认恢复',id);
   // 通过 inspectCommandSync 确认受管进程确实已终止
   if(!op.result?.processesEnded&&inspectCommandSync(op.identity)!=='ended')throw new CommandSafetyError('受管进程仍活跃或身份/终止无法确认，不能放行冲突写入',id);
  }
  // A failed journal must be writable again before any explicit recovery can clear memory protection.
  event(s.id,'command_recovery_checked',{projectId:s.project_id});blocked.delete(s.project_id);
 }

 /**
  * execute - 安全执行一条命令，完整管理其生命周期
  *
  * 流程：前置检查 → 预检命令 → 记录意图 → 执行命令 → 持久化终态 → 验证副作用
  * 每一步失败都会将项目标记为 blocked，直到人工 recover。
  *
  * @param s - 当前会话
  * @param tool - 工具名称（如 'run_command' 或 'verify'）
  * @param args - 命令参数
  * @param signal - AbortSignal，用于取消执行
  * @param context - 可选的上下文覆盖（root 路径和环境变量）
  * @returns 命令终态结果，包含输出引用、哈希等
  */
 async function execute(s:Session,tool:string,args:Record<string,unknown>,signal:AbortSignal,context?:{root:string;env:NodeJS.ProcessEnv}){
  if(signal.aborted)throw new Error('执行已停止');
  // 确保没有未核对的副作用后才允许执行新命令
  assertClear(s);const operationId=randomUUID(),root=context?.root??deps.root(s.project_id),identity={jobName:'Local\\ApiX-Command-'+operationId};
  try{preflightCommand(root,args);}catch(error){throw new PreflightError(error);}
  const values=deps.protectedValues(),version=deps.policy(s.project_id).version;
  // verify 命令需要记录执行前的项目指纹，用于执行后对比是否被意外修改
  let before:string|null=null;if(tool==='verify')before=projectFingerprint(root);
  let intentId:number;
  try{intentId=Number(event(s.id,'command_intent',{operationId,projectId:s.project_id,sessionId:s.id,identity,commandHash:createHash('sha256').update(JSON.stringify(args)).digest('hex'),tool,startedAt:now()}).lastInsertRowid);}
  catch(error){blocked.add(s.project_id);throw new CommandSafetyError('执行意图未可靠保存，命令未启动：'+safe(error),operationId);}
  inFlight.add(operationId);
  // 收集所有需要脱敏的密钥值，用于日志输出过滤
  const secrets=[...values,...Object.entries({...process.env,...deps.env()}).filter(([key,value])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(key)&&value&&value.length>=6).map(([,value])=>value!)];
  const log=logs.start(s.id,operationId,secrets);
  try{
   const result=await commandTool(root,args,context?.env??deps.env(),signal,()=>{},values,{operationId,identity:identity=>event(s.id,'command_identity',{operationId,projectId:s.project_id,identity}),output:(channel,text)=>log.write(channel,text)});
   result.log=log.finish(result.captureError);
   // 策略版本在执行期间变化 → 视为权限被撤回，标记需要人工审查
   if(deps.policy(s.project_id).version!==version){result.aborted=true;result.sideEffectsNeedReview=true;result.executionComplete=false;result.reason='permission_revoked';}
   const outputRef=randomUUID(),terminal={...result,outputRef,evidencePersisted:true,...(tool==='verify'?{fingerprint:projectFingerprint(root)}:{})},body=JSON.stringify(terminal);
   // 使用 SAVEPOINT 事务确保终态证据原子写入：输出记录 + 事件记录
   try{db.exec('SAVEPOINT assistant_command_terminal');db.prepare('INSERT INTO assistant_outputs VALUES (?,?,?,?,?,?)').run(outputRef,s.id,intentId,body,createHash('sha256').update(body).digest('hex'),now());event(s.id,'command_finished',{...terminal,output:undefined});db.exec('RELEASE assistant_command_terminal');}
   catch(error){try{db.exec('ROLLBACK TO assistant_command_terminal');db.exec('RELEASE assistant_command_terminal');}catch{console.error('命令终态事务回滚未确认；必须核对持久化状态');}blocked.add(s.project_id);throw new CommandSafetyError('命令最终证据未可靠保存，不得宣称成功：'+safe(error),operationId);}
   // 异常或部分副作用待核对时，记录 process_unknown 事件供后续审查
   if(result.sideEffectsNeedReview||result.unknown)try{event(s.id,'process_unknown',{resource:'command_operation',operationId,processesEnded:result.processesEnded,error:'命令异常或部分副作用待核对；不自动重放'});}catch(error){blocked.add(s.project_id);throw new CommandSafetyError('命令异常状态未可靠保存：'+safe(error),operationId);}
   // verify 命令不应修改项目文件；若指纹变化说明有意外的副作用
   if(before!==null&&before!==projectFingerprint(root)&&!result.sideEffectsNeedReview)throw new Error('验证命令修改了项目文件，请重新检查并验证');
   return terminal;
  }catch(error){
   if(error instanceof CommandSafetyError)throw error;
   // Validation/startup failures must have a trustworthy terminal too; an absent terminal remains gated.
   // 没有终态记录的错误 → 阻塞项目，防止不可信状态下的后续操作
   if(!row("SELECT id FROM assistant_events WHERE session_id=? AND kind='command_finished' AND json_extract(body,'$.operationId')=?",s.id,operationId)){
    blocked.add(s.project_id);throw new CommandSafetyError('执行没有可靠终态，请核对：'+safe(error),operationId);
   }throw error;
  }finally{inFlight.delete(operationId);}
 }
 return {execute,assertClear,recover,readOutput:logs.read};
}
