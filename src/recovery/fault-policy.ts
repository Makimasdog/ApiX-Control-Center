export type FaultCategory='cancelled'|'authentication'|'configuration'|'quota'|'rate_limit'|'transient'|'timeout'|'validation'|'conflict'|'execution'|'unknown_effect'|'unresponsive'|'storage'|'protocol';
export interface Fault {schema:1;category:FaultCategory;strategy:'retry'|'repair'|'stop'|'review';retryable:boolean}
export interface FaultContext {kind?:'model'|'tool'|'agent';status?:number;sideEffects?:boolean;safeToRetry?:boolean;outputStarted?:boolean;serviceCode?:string}
export function classifyFault(error:unknown,context:FaultContext={}):Fault {
  if(error instanceof FaultError&&!context.sideEffects)return error.fault;
  context={...context,status:context.status??(Number(String((error as Error)?.message??error??'').match(/(?:HTTP|status)\s*[:=]?\s*(\d{3})/i)?.[1])||undefined)};
  const e=error as {code?:string;message?:string},message=String(e?.message??error??''),code=String(e?.code??'');
  let category:FaultCategory='execution';
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
  if(context.sideEffects&&!(error instanceof PreflightError))category='unknown_effect';
  const retryable=context.kind==='model'&&context.safeToRetry===true&&!context.outputStarted&&['rate_limit','transient'].includes(category);
  const strategy=retryable?'retry':['unknown_effect','unresponsive','storage'].includes(category)?'review':['execution','validation','conflict','protocol'].includes(category)?'repair':'stop';
  return {schema:1,category,strategy,retryable};
}
export class PreflightError extends Error {constructor(error:unknown){super(error instanceof Error?error.message:String(error));}}
export class FaultError extends Error {constructor(message:string,readonly fault:Fault,readonly retryAfterMs=0){super(message);}}
export function retryDelay(attempt:number,retryAfterMs=0,random=Math.random){return Math.max(retryAfterMs,Math.min(8000,500*2**(attempt-1))*(0.75+random()*0.5));}
export function retryAfter(value:string|undefined,now=Date.now()){if(!value)return 0;const seconds=Number(value);return Number.isFinite(seconds)?Math.max(0,seconds*1000):Math.max(0,Date.parse(value)-now)||0;}
