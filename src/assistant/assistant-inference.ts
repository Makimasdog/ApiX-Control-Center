import {FaultError} from '../recovery/fault-policy.js';
import {randomUUID} from 'node:crypto';
import {ModelCleanupUnknownError,type ModelSettings} from '../models/model-backend.js';

interface Dependencies {
  settings(sessionId?:string):ModelSettings;
  account(projectId:string):string|null;
  reserve(id:string,projectId:string):unknown;
  settle(id:string,cost:null):unknown;
  pause(accountId:string|null,id:string):unknown;
  recordFailure?(record:{id:string;projectId:string;sessionId?:string;stage:string;error:string}):void;
  quotaFailure(message:string):boolean;
  infer(prompt:string,onDelta:undefined,context:{projectId:string;purpose:string;usagePurpose?:string;sessionId?:string;signal?:AbortSignal;modelSettings:ModelSettings}):Promise<string>;
}
export class InferenceAccountingError extends Error {readonly code='INFERENCE_ACCOUNTING_UNKNOWN';}

export function managerInferenceError(error:unknown,revoked:boolean):unknown {
  if(revoked&&!(error instanceof ModelCleanupUnknownError)&&!(error instanceof InferenceAccountingError))return new Error('ApiX 项目权限已变化，本次模型请求已中止');
  return error;
}

export function createAssistantInference(deps:Dependencies){
  const blocked=new Set<string>();
  return async(projectId:string,prompt:string,signal?:AbortSignal,sessionId?:string,usagePurpose='assistant_loop')=>{
    const id='assistant:'+randomUUID(),accountId=deps.account(projectId),settings=deps.settings(sessionId),secret=process.env[settings.apiKeyEnv];
    const key=accountId??projectId;
    if(blocked.has(key))throw new InferenceAccountingError('推理账本状态未确认，请核对账本并重启后恢复');
    const reserved=deps.reserve(id,projectId);
    const safe=(error:unknown)=>{let message=error instanceof Error?error.message:'模型调用失败';for(const value of [secret,...Object.entries(process.env).filter(([k,v])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(k)&&v&&v.length>=6).map(([,v])=>v!)])if(value)message=message.split(value).join('<redacted>');return message.slice(0,1000);};
    const failures:{stage:string;error:string;persisted:boolean}[]=[];
    const record=(stage:string,error:unknown)=>{
      blocked.add(key);const item={stage,error:safe(error),persisted:false};failures.push(item);
      try{if(!deps.recordFailure)throw new Error('未配置账本错误记录器');deps.recordFailure({id,projectId,sessionId,stage,error:item.error});item.persisted=true;}
      catch(recordError){failures.push({stage:'record',error:safe(recordError),persisted:false});console.error('ApiX 账本失败记录未可靠保存：'+safe(recordError));}
    };
    let result:string|undefined,primary:Error|undefined;
    try{result=await deps.infer(prompt,undefined,{projectId,purpose:'assistant_loop',usagePurpose,sessionId,signal,modelSettings:settings});}
    catch(error:unknown){
      primary=error instanceof ModelCleanupUnknownError?new ModelCleanupUnknownError(safe(error)):error instanceof FaultError?new FaultError(safe(error),error.fault,error.retryAfterMs):new Error(safe(error));
      // 用量持久化失败沿用费用账本的阻断机制，禁止静默丢账后继续同项目或共享账户推理。
      if(error instanceof InferenceAccountingError)record('token_usage',error);
      if(error instanceof FaultError?error.fault.category==='quota':deps.quotaFailure(error instanceof Error?error.message:'')){try{deps.pause(accountId,id);}catch(pauseError){record('pause',pauseError);}}
    }finally{if(reserved){try{deps.settle(id,null);}catch(error){record('settle',error);try{deps.pause(accountId,id);}catch(pauseError){record('pause',pauseError);}}}}
    if(failures.length){const message='推理账本状态未确认；'+failures.map(f=>`${f.stage}: ${f.error}${f.persisted?'':'（记录未可靠保存）'}`).join('；');if(primary instanceof ModelCleanupUnknownError)primary.message+='；'+message;else primary=new InferenceAccountingError(message);Object.assign(primary,{accountingFailures:failures});}
    if(primary)throw primary;return result!;
  };
}
