import {setTimeout as sleep} from 'node:timers/promises';
import {classifyFault,FaultError,retryDelay,retryAfter} from '../recovery/fault-policy.js';
import {reasoningParameters} from './conversation-models.js';
import {getProviderConfig,isLoopbackModelUrl,validateModelConfig} from './model-providers.js';
import {request as httpRequest, type ClientRequest, type IncomingMessage} from 'node:http';
import {request as httpsRequest} from 'node:https';
import type {Socket} from 'node:net';
import {modelEndpoint} from './model-endpoint.js';
import {modelUsage,unknownUsage,type ModelUsage,type ModelAttempt} from './model-usage.js';

export interface ModelSettings {provider:string;model:string;baseUrl:string;apiType:string;apiKeyEnv:string;reasoningEffort?:string;contextWindow?:number|null}
// Only host-created instances may retain this code across inference boundaries.
export class ModelCleanupUnknownError extends Error {
  readonly code='MODEL_CLEANUP_UNKNOWN';
}
export function directModelSettings(saved:ModelSettings):ModelSettings {
  const preset=!saved.baseUrl?getProviderConfig(saved.provider):undefined;
  const settings=preset?{...saved,baseUrl:preset.baseUrl,apiType:preset.apiType,apiKeyEnv:saved.apiKeyEnv||preset.defaultApiKeyEnv||''}:saved;
  if(!settings.baseUrl||!settings.model)throw new Error('请先配置 ApiX 的模型 API 地址与模型 ID；Pi、Codex、Claude 是可选执行 Agent，不是推理底座。');
  const check=validateModelConfig(settings);if(!check.valid)throw new Error(check.error);
  if(settings.apiKeyEnv&&!process.env[settings.apiKeyEnv])throw new Error('模型密钥环境变量未设置，请配置后重启 ApiX');
  if(!settings.apiKeyEnv&&!isLoopbackModelUrl(settings.baseUrl))throw new Error('远程模型必须配置 API Key 环境变量');
  return settings;
}

const system='你是 ApiX 的独立模型决策组件。工具、Skills、上下文、委派、权限与验收由 ApiX 宿主管理；模型本身没有本机工具，不得虚构操作或自行启动其他 Agent。遵守输入中的 JSON 契约，只返回一个完整 JSON 对象，不加 Markdown 或前言。公开回复放在契约指定的 question、reply、message 或 summary 字段，不输出隐藏推理过程。';
type Json=Record<string,any>;
const parts=(value:unknown,type='text'):string=>Array.isArray(value)?value.filter(p=>p?.type===type&&typeof p.text==='string').map(p=>p.text).join(''):'';
function serviceFailure(data:Json):Error {
  const code=String(data.error?.code??data.error?.type??data.response?.error?.code??'');
  const fault=classifyFault(null,{kind:'model',serviceCode:code});
  return new FaultError(fault.category==='quota'?'模型服务额度不足 (insufficient_quota)':fault.category==='rate_limit'?'模型服务触发速率限制 (rate_limit_error)':'模型未返回可用答复（服务返回错误或未完成）',fault);
}
function finalText(data:Json,api:string):string {
  if(data.error)throw serviceFailure(data);
  if(api==='openai-completions'){
    const choice=data.choices?.[0];if(choice?.finish_reason!=='stop')throw new Error('模型输出未完整结束或试图调用未提供的工具');
    return typeof choice.message?.content==='string'?choice.message.content:parts(choice.message?.content);
  }
  if(api==='openai-responses'){
    if(data.status!=='completed')throw new Error('模型响应未完成');
    return (Array.isArray(data.output)?data.output:[]).filter((p:Json)=>p.type==='message'&&p.role==='assistant').map((p:Json)=>parts(p.content,'output_text')).join('');
  }
  if(!['end_turn','stop_sequence'].includes(data.stop_reason))throw new Error('模型消息未完整结束');
  return parts(data.content);
}

interface InferenceOptions {signal?:AbortSignal;timeoutMs?:number;maxAttempts?:number;onRetry?:(info:{attempt:number;delayMs:number;fault:ReturnType<typeof classifyFault>})=>void;onAttemptStart?:(attempt:number)=>void;onAttempt?:(value:ModelAttempt)=>void;onUsage?:(usage:ModelUsage,complete:boolean)=>void}
export async function inferModel(saved:ModelSettings,prompt:string,onDelta?:(delta:string)=>void,options:InferenceOptions={}):Promise<string>{
  const attempts=options.maxAttempts??3,totalMs=options.timeoutMs??90000;
  if(!Number.isSafeInteger(totalMs)||totalMs<=0||totalMs>2147483647)throw new Error('模型请求超时配置无效');
  const deadline=Date.now()+totalMs;
  if(!Number.isSafeInteger(attempts)||attempts<1||attempts>3)throw new Error('模型重试次数应为 1–3');
  for(let attempt=1;;attempt++){
    const started=Date.now();let usage=unknownUsage(),usageComplete=false,status:ModelAttempt['status']='failed',primary:unknown;
    // 登记失败时直接停止，确保请求不会在缺少账本记录的情况下发往供应商。
    options.onAttemptStart?.(attempt);
    try{
      try{const result=await inferAttempt(saved,prompt,onDelta,{...options,timeoutMs:Math.max(1,deadline-Date.now()),onUsage:(value,complete)=>{usage=value;usageComplete=complete;}});status='completed';return result;}
      catch(error){primary=error;throw error;}
      // 清理未知是更高优先级的安全事实；记账再次失败时补充说明，不覆盖原来的清理错误。
      finally{try{options.onAttempt?.({attempt,status,durationMs:Date.now()-started,usage,usageComplete});}catch(error){if(primary instanceof ModelCleanupUnknownError)primary.message+='；Token 用量记录未确认';else throw error;}}
    }catch(error){
    if(!(error instanceof FaultError)||!error.fault.retryable||attempt>=attempts||options.signal?.aborted)throw error;
    const delayMs=Math.ceil(retryDelay(attempt,error.retryAfterMs));if(!Number.isFinite(delayMs)||Date.now()+delayMs>=deadline)throw error;
    options.onRetry?.({attempt:attempt+1,delayMs,fault:error.fault});
    try{await sleep(delayMs,undefined,{signal:options.signal});}catch{throw new Error('模型退避等待已停止');}
    if(Date.now()>=deadline)throw error;
  }}
}
async function inferAttempt(saved:ModelSettings,prompt:string,onDelta:((delta:string)=>void)|undefined,options:InferenceOptions):Promise<string>{
  const settings=directModelSettings(saved),api=settings.apiType,key=settings.apiKeyEnv?process.env[settings.apiKeyEnv]:undefined;
  if(Buffer.byteLength(prompt)>512*1024)throw new Error('模型上下文超过 512 KiB，请整理或拆分任务');
  const endpoint=modelEndpoint(settings.baseUrl,api);
  // Some Qwen thinking models require streaming even when the caller only needs the final JSON.
  const stream=true;
  const body=api==='openai-responses'?{model:settings.model,instructions:system,input:prompt,stream,store:false}:api==='anthropic-messages'?{model:settings.model,system,messages:[{role:'user',content:prompt}],max_tokens:8192,stream}:{model:settings.model,messages:[{role:'system',content:system},{role:'user',content:prompt}],stream};
  // Chat Completions 的流式用量在额外终端块中返回，需要显式请求。
  if(api==='openai-completions')Object.assign(body,{stream_options:{include_usage:true}});
  Object.assign(body,reasoningParameters(settings));
  const headers:Record<string,string>={'Content-Type':'application/json','Accept':stream?'text/event-stream':'application/json'};
  if(key)headers[api==='anthropic-messages'?'x-api-key':'Authorization']=api==='anthropic-messages'?key:'Bearer '+key;
  if(api==='anthropic-messages')headers['anthropic-version']='2023-06-01';
  const timeoutMs=options.timeoutMs??90000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0||timeoutMs>2147483647)throw new Error('模型请求超时配置无效');
  if(options.signal?.aborted)throw new Error('模型请求已停止');
  // Own the transport: destroying it must terminate both pending headers and body reads.
  // No pooled connection or unbounded Web reader.cancel() remains after settlement.
  let request:ClientRequest|undefined,response:IncomingMessage|undefined,socket:Socket|undefined;
  let settled=false,closed=false,connected=false,phase='connection',timer:ReturnType<typeof setTimeout>|undefined;
  let close!:()=>void;const transportClosed=new Promise<void>(resolve=>{close=()=>{closed=true;resolve();};});
  let finish!:(error?:unknown,value?:string)=>void;
  const abort=()=>finish(new Error(`模型请求已停止（${phase}）`));
  try{
    let bytes=0,raw='',answer='',pending='',complete=false,terminal=false;const decoder=new TextDecoder();
    let usage=unknownUsage(),usageSeen=false;
    // 中途保留已观测值；只有成功终端事件且输入、输出均已知，才标记用量完整。
    const observe=(value:unknown,final=false)=>{if(value&&typeof value==='object'&&!Array.isArray(value)){usage=modelUsage(api,value as Json,usage);usageSeen=true;}if(usageSeen)options.onUsage?.(usage,final&&usage.inputTokens!==null&&usage.outputTokens!==null);};
    const append=(value:unknown)=>{if(typeof value!=='string')return;answer+=value;if(answer.length>100000)throw new Error('模型输出超过 100000 字符');onDelta?.(value);};
    const event=(frame:string)=>{
      const payload=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!payload)return;
      if(payload==='[DONE]'){if(api!=='openai-completions'||!complete)throw new Error('模型流结束标记不符合协议');observe(null,true);terminal=true;return;}
      const data=JSON.parse(payload) as Json;
      if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('模型流事件格式无效');
      observe(api==='openai-responses'?data.response?.usage:api==='anthropic-messages'&&data.type==='message_start'?data.message?.usage:data.usage);
      if(data.error||['error','response.failed','response.incomplete'].includes(data.type))throw serviceFailure(data);
      if(api==='openai-completions'){
        const c=data.choices?.[0];if(!c)return;if(c.index!==undefined&&c.index!==0)return;
        append(c.delta?.content);if(c.finish_reason){if(c.finish_reason!=='stop')throw new Error('模型流被截断或包含未提供的工具');complete=true;}
      }else if(api==='openai-responses'){
        if(data.type==='response.output_text.delta')append(data.delta);
        if(data.type==='response.completed'){const full=finalText(data.response,api);if(!answer)append(full);else if(full!==answer)throw new Error('模型流与最终文本不一致');observe(null,true);complete=true;terminal=true;}
      }else{
        if(data.type==='content_block_start'&&data.content_block?.type==='text')append(data.content_block.text);
        if(data.type==='content_block_delta'&&data.delta?.type==='text_delta')append(data.delta.text);
        if(data.type==='message_delta'&&data.delta?.stop_reason){if(!['end_turn','stop_sequence'].includes(data.delta.stop_reason))throw new Error('模型消息流未完整结束');complete=true;}
        if(data.type==='message_stop'){if(!complete)throw new Error('模型消息流缺少停止原因');observe(null,true);terminal=true;}
      }
    };
    return await new Promise<string>((resolve,reject)=>{
      finish=(error,value)=>{
        if(settled)return;settled=true;
        clearTimeout(timer);options.signal?.removeEventListener('abort',abort);
        response?.removeAllListeners('data');
        // Destroy before resolving; cleanup below waits for the actual socket close acknowledgement.
        response?.destroy();request?.destroy();socket?.destroy();
        if(!request)close();
        if(error)reject(error);else if(!value?.trim())reject(new Error('模型未返回可用答复'));else resolve(value.trim());
      };
      const failed=(error?:Error)=>finish(new FaultError(`模型连接或传输失败（${phase}）`,classifyFault(error,{kind:'model',safeToRetry:!!socket&&!connected&&!response,outputStarted:answer.length>0})));
      const guarded=(work:()=>void)=>{if(settled)return;try{work();}catch(error){finish(error);}};
      timer=setTimeout(()=>finish(new Error(`模型请求超时（${timeoutMs} ms，${phase}）；没有自动重试`)),timeoutMs);
      options.signal?.addEventListener('abort',abort,{once:true});
      try{
        request=(endpoint.protocol==='https:'?httpsRequest:httpRequest)(endpoint,{method:'POST',headers,agent:false},incoming=>{
          response=incoming;if(settled){incoming.destroy();return;}phase='headers';
          incoming.on('error',failed);
          incoming.on('aborted',failed);
          const status=incoming.statusCode??0;
          if(status<200||status>=300){
            let errorBody='';const rejected=()=>{let serviceCode='';try{const value=JSON.parse(errorBody);serviceCode=String(value?.error?.code??value?.error?.type??'');}catch{}
              const fault=classifyFault(null,{kind:'model',status,serviceCode,safeToRetry:true,outputStarted:false});
              const message=status===404?`模型服务返回 HTTP 404：接口路径或模型不存在。当前请求 ${endpoint.origin}${endpoint.pathname}；模型 ${settings.model}。请核对服务地址、协议与模型 ID；旧对话可点击“使用当前应用配置”更新。`:status===401||status===403?`模型服务返回 HTTP ${status}：认证或访问权限失败，请核对当前服务对应的 API Key。`:fault.category==='quota'?`模型服务额度不足 (insufficient_quota，HTTP ${status})`:`模型服务返回 HTTP ${status}（${fault.category}）`;
              finish(new FaultError(message,fault,retryAfter(typeof incoming.headers['retry-after']==='string'?incoming.headers['retry-after']:undefined)));
            };
            incoming.on('data',(chunk:Buffer)=>{if(Buffer.byteLength(errorBody)+chunk.length>16000){rejected();return;}errorBody+=chunk.toString('utf8');});incoming.on('end',rejected);return;
          }
          phase='body';const sse=incoming.headers['content-type']?.includes('text/event-stream');
          incoming.on('data',(value:Buffer)=>guarded(()=>{
            bytes+=value.byteLength;if(bytes>2*1024*1024)throw new Error('模型响应超过 2 MiB');
            const chunk=decoder.decode(value,{stream:true});
            if(!sse){raw+=chunk;return;}
            pending=(pending+chunk).replace(/\r\n/g,'\n');let end;
            while(!settled&&(end=pending.indexOf('\n\n'))>=0){
              event(pending.slice(0,end));pending=pending.slice(end+2);
              if(complete&&terminal){phase='protocol';finish(undefined,answer);}
            }
          }));
          incoming.on('end',()=>guarded(()=>{
            const tail=decoder.decode();
            if(sse){
              // SSE events require a blank line; EOF must not promote a partial terminal frame.
              if(!complete||!terminal)throw new Error('模型流中断，未收到完整结束标记');
            }else{
              const data=JSON.parse(raw+tail) as Json;observe(data.usage);answer=finalText(data,api);observe(null,true);
              if(answer.length>100000)throw new Error('模型输出超过 100000 字符');onDelta?.(answer);
            }
            phase='protocol';finish(undefined,answer);
          }));
          incoming.on('close',()=>{if(!incoming.complete)failed();});
        });
        request.on('socket',assigned=>{socket=assigned;assigned.once('connect',()=>{connected=true;});assigned.once('close',close);if(settled)assigned.destroy();});
        request.on('close',()=>{if(!socket)close();});
        request.on('error',failed);
        request.once('finish',()=>{if(!settled&&phase==='connection')phase='headers';});
        request.end(JSON.stringify(body));
      }catch(error){finish(error);}
    });
  }catch(error){
    let message=error instanceof Error?error.message:'模型调用失败';
    if(error instanceof SyntaxError||error instanceof TypeError)message='模型服务无法连接或响应格式无效，请检查 API 地址、协议和服务状态';
    if(key)message=message.split(key).join('<redacted>');throw error instanceof FaultError?new FaultError(message.slice(0,1000),error.fault,error.retryAfterMs):new FaultError(message.slice(0,1000),classifyFault(error,{kind:'model'}));
  }finally{
    clearTimeout(timer);options.signal?.removeEventListener('abort',abort);
    let cleanupTimer:ReturnType<typeof setTimeout>|undefined;
    try{
      await Promise.race([transportClosed,new Promise<void>((_,reject)=>{
        cleanupTimer=setTimeout(()=>reject(new ModelCleanupUnknownError(`模型传输清理未确认（${phase}，1000 ms）；资源状态未知，请人工核对；没有自动重试`)),1000);
      })]);
    }finally{clearTimeout(cleanupTimer);if(closed){response?.removeAllListeners();request?.removeAllListeners();}}
  }
}
