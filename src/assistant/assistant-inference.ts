/**
 * 推理调用管理 (Inference Manager) — 封装与 LLM 的实际通信，处理账本、配额、失败恢复
 *
 * 所属层级：助手层 - 推理通信
 * 核心功能：
 *   1. 管理推理调用的账本预留 (reserve) 与结算 (settle)
 *   2. 失败时记录账本并阻断后续调用，防止静默丢账
 *   3. 自动脱敏错误信息中的 API 密钥等敏感数据
 *   4. 配额不足时暂停账户，阻止同项目或共享账户的后续推理
 * 依赖关系：
 *   - 被 [→ 见 src/assistant/assistant-loop.ts] 的 deps.infer 调用
 *   - 调用 [→ 见 src/models/model-backend.ts] 的 ModelSettings 和实际推理接口
 *   - 依赖外部的 reserve/settle/pause 账本接口
 */
import {FaultError} from '../recovery/fault-policy.js';
import {randomUUID} from 'node:crypto';
import {ModelCleanupUnknownError,type ModelSettings} from '../models/model-backend.js';
import type {PromptDescriptor} from '../models/prompt-diagnostics.js';

/** 推理账本依赖接口 — 定义外部账本系统必须提供的能力 */
interface Dependencies {
  settings(sessionId?:string):ModelSettings;
  account(projectId:string):string|null;
  reserve(id:string,projectId:string):unknown;
  settle(id:string,cost:null):unknown;
  pause(accountId:string|null,id:string):unknown;
  recordFailure?(record:{id:string;projectId:string;sessionId?:string;stage:string;error:string}):void;
  quotaFailure(message:string):boolean;
  infer(prompt:string,onDelta:undefined,context:{projectId:string;purpose:string;usagePurpose?:string;sessionId?:string;signal?:AbortSignal;modelSettings:ModelSettings;promptDescriptor?:PromptDescriptor}):Promise<string>;
}
/** 推理账本状态未确认错误 — 当账本持久化失败时抛出，阻断后续推理调用 */
export class InferenceAccountingError extends Error {readonly code='INFERENCE_ACCOUNTING_UNKNOWN';}

/**
 * managerInferenceError - 将底层模型错误转换为上层可处理的错误类型
 * @param error - 原始错误对象
 * @param revoked - 项目权限是否已变化
 * @returns 转换后的错误；若权限已变化则统一返回中止错误
 */
export function managerInferenceError(error:unknown,revoked:boolean):unknown {
  if(revoked&&!(error instanceof ModelCleanupUnknownError)&&!(error instanceof InferenceAccountingError))return new Error('ApiX 项目权限已变化，本次模型请求已中止');
  return error;
}

/**
 * createAssistantInference - 创建推理调用管理器，封装账本预留/结算/失败阻断逻辑
 * @param deps - 账本依赖对象
 * @returns 异步推理函数 (projectId, prompt, signal?, sessionId?, usagePurpose?) => string
 * 设计意图：将账本关注点（预留、结算、失败记录、配额暂停）与模型调用解耦，
 * 账本失败时阻断后续调用而非静默丢账，确保费用可追溯。
 */
export function createAssistantInference(deps:Dependencies){
  /** blocked — 账本状态未确认的项目/账户集合，一旦失败即阻断后续调用 */
  const blocked=new Set<string>();
  return async(projectId:string,prompt:string,signal?:AbortSignal,sessionId?:string,usagePurpose='assistant_loop',promptDescriptor?:PromptDescriptor)=>{
    const id='assistant:'+randomUUID(),accountId=deps.account(projectId),settings=deps.settings(sessionId),secret=process.env[settings.apiKeyEnv];
    const key=accountId??projectId;
    if(blocked.has(key))throw new InferenceAccountingError('推理账本状态未确认，请核对账本并重启后恢复');
    // 账本预留：在调用 LLM 前先预留额度，失败则直接阻断
    const reserved=deps.reserve(id,projectId);
    /** safe - 脱敏函数：将错误信息中的 API 密钥等敏感环境变量替换为 <redacted> */
    const safe=(error:unknown)=>{let message=error instanceof Error?error.message:'模型调用失败';for(const value of [secret,...Object.entries(process.env).filter(([k,v])=>/KEY|TOKEN|SECRET|PASSWORD/i.test(k)&&v&&v.length>=6).map(([,v])=>v!)])if(value)message=message.split(value).join('<redacted>');return message.slice(0,1000);};
    const failures:{stage:string;error:string;persisted:boolean}[]=[];
    const record=(stage:string,error:unknown)=>{
      blocked.add(key);const item={stage,error:safe(error),persisted:false};failures.push(item);
      try{if(!deps.recordFailure)throw new Error('未配置账本错误记录器');deps.recordFailure({id,projectId,sessionId,stage,error:item.error});item.persisted=true;}
      catch(recordError){failures.push({stage:'record',error:safe(recordError),persisted:false});console.error('ApiX 账本失败记录未可靠保存：'+safe(recordError));}
    };
    // 调用底层 LLM 推理接口，捕获并分类处理各类失败
    let result:string|undefined,primary:Error|undefined;
    try{result=await deps.infer(prompt,undefined,{projectId,purpose:'assistant_loop',usagePurpose,sessionId,signal,modelSettings:settings,promptDescriptor});}
    catch(error:unknown){
      primary=error instanceof ModelCleanupUnknownError?new ModelCleanupUnknownError(safe(error)):error instanceof FaultError?new FaultError(safe(error),error.fault,error.retryAfterMs):new Error(safe(error));
      // 用量持久化失败沿用费用账本的阻断机制，禁止静默丢账后继续同项目或共享账户推理。
      if(error instanceof InferenceAccountingError)record('token_usage',error);
      if(error instanceof FaultError?error.fault.category==='quota':deps.quotaFailure(error instanceof Error?error.message:'')){try{deps.pause(accountId,id);}catch(pauseError){record('pause',pauseError);}}
    }finally{if(reserved){try{deps.settle(id,null);}catch(error){record('settle',error);try{deps.pause(accountId,id);}catch(pauseError){record('pause',pauseError);}}}}
    // 汇总所有账本失败，构造最终错误对象并抛出
    if(failures.length){const message='推理账本状态未确认；'+failures.map(f=>`${f.stage}: ${f.error}${f.persisted?'':'（记录未可靠保存）'}`).join('；');if(primary instanceof ModelCleanupUnknownError)primary.message+='；'+message;else primary=new InferenceAccountingError(message);Object.assign(primary,{accountingFailures:failures});}
    if(primary)throw primary;return result!;
  };
}
