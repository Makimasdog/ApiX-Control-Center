/**
 * 故障策略定义 - 根据错误信息分类故障类型，决定重试/修复/停止/审查策略
 *
 * 所属层级：恢复层
 * 核心功能：
 *   - classifyFault：将错误分类为 14 种故障类型之一（认证、配额、限流、超时等）
 *   - 根据分类决定处理策略：retry（可重试）、repair（需修复）、stop（停止）、review（人工审查）
 *   - PreflightError：预检错误类，表示执行前的检查失败
 *   - FaultError：携带故障分类和重试延迟的错误类
 *   - retryDelay：指数退避 + 随机抖动的重试延迟计算
 *   - retryAfter：解析 HTTP Retry-After 头
 * 依赖关系：
 *   - 被 ← control-plane.mjs / 各 Agent 运行时调用，用于故障分类和恢复决策
 */
/** 故障分类枚举：涵盖认证、配额、限流、超时、冲突、存储等 14 种类型 */
export type FaultCategory='cancelled'|'authentication'|'configuration'|'quota'|'rate_limit'|'transient'|'timeout'|'validation'|'conflict'|'execution'|'unknown_effect'|'unresponsive'|'storage'|'protocol';
/** 故障分类结果：包含 schema 版本、分类、处理策略、是否可重试 */
export interface Fault {schema:1;category:FaultCategory;strategy:'retry'|'repair'|'stop'|'review';retryable:boolean}
/** 故障上下文：提供额外的分类线索（HTTP 状态码、是否有副作用、是否已开始输出等） */
export interface FaultContext {kind?:'model'|'tool'|'agent';status?:number;sideEffects?:boolean;safeToRetry?:boolean;outputStarted?:boolean;serviceCode?:string}
/**
 * classifyFault - 根据错误信息和上下文将故障分类
 * @param error - 原始错误对象
 * @param context - 故障上下文（HTTP 状态、副作用标记等）
 * @returns Fault 对象，包含分类、策略和是否可重试
 */
export function classifyFault(error:unknown,context:FaultContext={}):Fault {
  // 如果已经是 FaultError 且无副作用，直接返回已分类的结果
  if(error instanceof FaultError&&!context.sideEffects)return error.fault;
  // 从错误消息中提取 HTTP 状态码作为上下文补充
  context={...context,status:context.status??(Number(String((error as Error)?.message??error??'').match(/(?:HTTP|status)\s*[:=]?\s*(\d{3})/i)?.[1])||undefined)};
  const e=error as {code?:string;message?:string},message=String(e?.message??error??''),code=String(e?.code??'');
  let category:FaultCategory='execution';
  // 按优先级匹配错误码和消息，确定故障分类
  if(/UNKNOWN|ACCOUNTING|SQLITE|UNRESPONSIVE/.test(code))category=code==='AGENT_UNRESPONSIVE'?'unresponsive':code.includes('SQLITE')?'storage':'unknown_effect';
  else if(context.status===402||/insufficient_quota|quota_exceeded|resource_exhausted/.test(context.serviceCode??'')||/余额不足|额度耗尽|insufficient_quota|quota_exceeded/.test(message))category='quota';
  else if(context.status===401||context.status===403||/^(invalid_api_key|authentication_error|permission_denied)$/.test(context.serviceCode??'')||/(?:认证|凭据).{0,40}(?:失败|错误|无效|不可用|共用|冲突)|密钥不可用|unauthorized|invalid.api.key/i.test(message))category='authentication';
  else if(context.status===429||context.serviceCode==='rate_limit_error'||context.serviceCode==='rate_limit_exceeded')category='rate_limit';
  else if([500,502,503,504].includes(context.status??0)||/ECONNREFUSED|EAI_AGAIN|ENETUNREACH|ECONNRESET/.test(code))category='transient';
  else if(/abort|cancel|已停止|已取消/i.test(code+' '+message))category='cancelled';
  else if(context.status===408||/TIMEOUT|超时|timeout/i.test(code+' '+message))category='timeout';
  else if(context.status===404||context.status===302||context.serviceCode==='model_not_found'||/配置.{0,30}(?:无效|错误|未设置|不可用)|请先配置|协议不兼容|不存在的模型/.test(message))category='configuration';
  else if(context.status===409||/版本|冲突|SHA256|已变化|CONFLICT/.test(code+' '+message))category='conflict';
  else if(error instanceof SyntaxError||/JSON|格式无效|流中断|未完整|未完成/.test(message))category='protocol';
  else if(context.status===400||context.status===422||/参数|校验|无效/.test(message))category='validation';
  // 如果有副作用且不是预检错误，一律归为 unknown_effect（不确定是否产生了部分效果）
  if(context.sideEffects&&!(error instanceof PreflightError))category='unknown_effect';
  // 可重试条件：model 类型 + safeToRetry + 未开始输出 + 限流或瞬态故障
  const retryable=context.kind==='model'&&context.safeToRetry===true&&!context.outputStarted&&['rate_limit','transient'].includes(category);
  // 根据分类决定处理策略
  const strategy=retryable?'retry':['unknown_effect','unresponsive','storage'].includes(category)?'review':['execution','validation','conflict','protocol'].includes(category)?'repair':'stop';
  return {schema:1,category,strategy,retryable};
}
/** PreflightError - 预检错误，表示执行前的检查未通过（如参数校验、权限检查） */
export class PreflightError extends Error {constructor(error:unknown){super(error instanceof Error?error.message:String(error));}}
/** FaultError - 携带故障分类信息的错误，支持重试延迟 */
export class FaultError extends Error {constructor(message:string,readonly fault:Fault,readonly retryAfterMs=0){super(message);}}
/**
 * retryDelay - 计算指数退避 + 随机抖动的重试延迟
 * @param attempt - 当前重试次数（从 1 开始）
 * @param retryAfterMs - 服务端建议的等待时间（毫秒）
 * @param random - 随机数生成器（默认 Math.random，便于测试注入）
 * @returns 延迟毫秒数，范围在 retryAfterMs 到 8000 之间
 */
export function retryDelay(attempt:number,retryAfterMs=0,random=Math.random){return Math.max(retryAfterMs,Math.min(8000,500*2**(attempt-1))*(0.75+random()*0.5));}
/**
 * retryAfter - 解析 HTTP Retry-After 头值
 * @param value - Retry-After 头的字符串值（秒数或 HTTP 日期）
 * @param now - 当前时间戳（毫秒），默认 Date.now()
 * @returns 需要等待的毫秒数
 */
export function retryAfter(value:string|undefined,now=Date.now()){if(!value)return 0;const seconds=Number(value);return Number.isFinite(seconds)?Math.max(0,seconds*1000):Math.max(0,Date.parse(value)-now)||0;}
