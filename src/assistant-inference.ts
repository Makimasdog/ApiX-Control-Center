import {randomUUID} from 'node:crypto';
import {ModelCleanupUnknownError,type ModelSettings} from './model-backend.js';

interface Dependencies {
  settings(sessionId?:string):ModelSettings;
  account(projectId:string):string|null;
  reserve(id:string,projectId:string):unknown;
  settle(id:string,cost:null):unknown;
  pause(accountId:string|null,id:string):unknown;
  quotaFailure(message:string):boolean;
  infer(prompt:string,onDelta:undefined,context:{projectId:string;purpose:string;signal?:AbortSignal;modelSettings:ModelSettings}):Promise<string>;
}

export function managerInferenceError(error:unknown,revoked:boolean):unknown {
  if(revoked&&!(error instanceof ModelCleanupUnknownError))return new Error('ApiX 项目权限已变化，本次模型请求已中止');
  return error;
}

export function createAssistantInference(deps:Dependencies){
  return async(projectId:string,prompt:string,signal?:AbortSignal,sessionId?:string)=>{
    const id='assistant:'+randomUUID(),accountId=deps.account(projectId),settings=deps.settings(sessionId),secret=process.env[settings.apiKeyEnv];
    const reserved=deps.reserve(id,projectId);
    try{return await deps.infer(prompt,undefined,{projectId,purpose:'assistant_loop',signal,modelSettings:settings});}
    catch(error:unknown){
      const message=error instanceof Error?error.message:'模型调用失败';
      if(deps.quotaFailure(message))deps.pause(accountId,id);
      const safe=(secret?message.split(secret).join('<redacted>'):message).slice(0,1000);
      // Copy only a sanitized message and the one host-owned type, never cause or response fields.
      throw error instanceof ModelCleanupUnknownError?new ModelCleanupUnknownError(safe):new Error(safe);
    }finally{if(reserved)deps.settle(id,null);}
  };
}
