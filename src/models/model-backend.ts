/**
 * 后端抽象 - 模型调用的核心实现，负责 HTTP 请求构建、流式响应解析、重试与错误处理
 *
 * 所属层级：模型层（src/models/）
 * 核心功能：
 *   1. directModelSettings() 解析并验证用户保存的模型设置
 *   2. inferModel() 带重试和超时的模型推理入口，支持流式输出
 *   3. inferAttempt() 单次请求实现：发送已准备的请求体、处理 SSE 流、解析各协议响应
 *   4. 安全机制：API Key 脱敏、传输资源清理、超时保护
 * 依赖关系：
 *   - 依赖 model-providers.ts 获取提供商配置
 *   - 依赖 model-endpoint.ts 构建请求 URL
 *   - 依赖 model-usage.ts 记录 Token 用量
 *   - 依赖 conversation-models.ts 获取推理参数
 *   - 依赖 recovery/fault-policy.js 进行故障分类与重试策略
 *   - 被 src/coordination/ 层调用以执行 LLM 推理
 */
import {setTimeout as sleep} from 'node:timers/promises';
import {classifyFault,FaultError,retryDelay,retryAfter} from '../recovery/fault-policy.js';
import {request as httpRequest, type ClientRequest, type IncomingMessage} from 'node:http';
import {request as httpsRequest} from 'node:https';
import type {Socket} from 'node:net';
import {modelUsage,unknownUsage,type ModelUsage,type ModelAttempt} from './model-usage.js';

import {prepareModelRequest,type PreparedModelRequest,type ModelSettings} from './model-request.js';
import {createPromptDiagnostics,emptyTransport,type DiagnosticScope,type PromptDescriptor,type RequestDiagnostic} from './prompt-diagnostics.js';
export {directModelSettings,type ModelSettings} from './model-request.js';
const defaultDiagnostics=createPromptDiagnostics();

/**
 * ModelCleanupUnknownError - 模型传输清理未确认时抛出的安全错误
 * 只有宿主创建的实例才能跨推理边界保留此错误码
 */
// Only host-created instances may retain this code across inference boundaries.
export class ModelCleanupUnknownError extends Error {
  readonly code='MODEL_CLEANUP_UNKNOWN';
}

type Json=Record<string,any>;

/**
 * parts - 从内容数组中提取指定类型的文本并拼接
 * @param value - 内容数组或空值
 * @param type - 要提取的内容类型，默认 'text'
 */
const parts=(value:unknown,type='text'):string=>Array.isArray(value)?value.filter(p=>p?.type===type&&typeof p.text==='string').map(p=>p.text).join(''):'';

/**
 * serviceFailure - 将服务返回的错误码分类并转换为友好的 FaultError
 * @param data - 服务响应数据
 */
function serviceFailure(data:Json):Error {
  const code=String(data.error?.code??data.error?.type??data.response?.error?.code??'');
  const fault=classifyFault(null,{kind:'model',serviceCode:code});
  return new FaultError(fault.category==='quota'?'模型服务额度不足 (insufficient_quota)':fault.category==='rate_limit'?'模型服务触发速率限制 (rate_limit_error)':'模型未返回可用答复（服务返回错误或未完成）',fault);
}
/**
 * finalText - 从非流式响应中提取最终文本，检查响应完整性
 * @param data - 响应数据
 * @param api - API 协议类型
 * @returns 提取的文本内容
 */
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

/**
 * InferenceOptions - 推理请求的可选项配置
 */
interface InferenceOptions {signal?:AbortSignal;timeoutMs?:number;maxAttempts?:number;onRetry?:(info:{attempt:number;delayMs:number;fault:ReturnType<typeof classifyFault>})=>void;onAttemptStart?:(attempt:number)=>void;onAttempt?:(value:ModelAttempt)=>void;onUsage?:(usage:ModelUsage,complete:boolean)=>void;onRequestPrepared?:(attempt:number,value:RequestDiagnostic)=>void;promptDescriptor?:PromptDescriptor;diagnostics?:{scope:DiagnosticScope;usageId:()=>string;tracker?:ReturnType<typeof createPromptDiagnostics>}}

/**
 * inferModel - 带重试和超时的模型推理入口
 * 在总超时时间内最多重试 maxAttempts 次，每次失败后按指数退避等待
 * @param saved - 模型设置
 * @param prompt - 用户提示词
 * @param onDelta - 流式输出的增量回调
 * @param options - 可选项（超时、重试次数、事件回调等）
 * @returns 模型返回的文本内容
 */
export async function inferModel(saved:ModelSettings,prompt:string,onDelta?:(delta:string)=>void,options:InferenceOptions={}):Promise<string>{
  const attempts=options.maxAttempts??3,totalMs=options.timeoutMs??90000;
  if(!Number.isSafeInteger(totalMs)||totalMs<=0||totalMs>2147483647)throw new Error('模型请求超时配置无效');
  const deadline=Date.now()+totalMs;
  if(!Number.isSafeInteger(attempts)||attempts<1||attempts>3)throw new Error('模型重试次数应为 1–3');
  let prepared:PreparedModelRequest|undefined,eligible:ReturnType<ReturnType<typeof createPromptDiagnostics>['prepare']>|undefined;
  const tracker=options.diagnostics?.tracker??defaultDiagnostics;
  try{for(let attempt=1;;attempt++){
    const started=Date.now();let usage=unknownUsage(),usageComplete=false,status:ModelAttempt['status']='failed',primary:unknown,networkReady=false;
    const transportObservation=emptyTransport();
    // 登记失败时直接停止，确保请求不会在缺少账本记录的情况下发往供应商。
    options.onAttemptStart?.(attempt);
    try{
      try{
        prepared=options.onRequestPrepared?(prepared??prepareModelRequest(saved,prompt)):prepareModelRequest(saved,prompt);
        let diagnostic:ReturnType<typeof tracker.prepare>|undefined;
        if(options.onRequestPrepared){
          if(!options.diagnostics)throw new Error('请求诊断缺少宿主作用域');
          diagnostic=tracker.prepare(options.diagnostics.scope,options.diagnostics.usageId(),attempt,prepared,options.promptDescriptor);
          const hookResult:unknown=options.onRequestPrepared(attempt,diagnostic.metadata);
          if(hookResult&&typeof (hookResult as PromiseLike<unknown>).then==='function'){void Promise.resolve(hookResult).catch(()=>{});throw new Error('请求诊断保存只支持同步回调；没有启动网络请求');}
        }
        const remaining=deadline-Date.now();
        if(remaining<=0)throw new Error('模型请求准备或记账已超过总时限；没有启动网络请求');
        if(options.signal?.aborted)throw new Error('模型请求已停止');
        networkReady=true;
        const result=await inferAttempt(prepared,onDelta,{...options,timeoutMs:remaining,onUsage:(value,complete)=>{usage=value;usageComplete=complete;}},transportObservation,()=>{if(diagnostic){tracker.headers(diagnostic);eligible=diagnostic;}});status='completed';return result;
      }
      catch(error){primary=error;throw error;}
      // 清理未知是更高优先级的安全事实；记账再次失败时补充说明，不覆盖原来的清理错误。
      finally{try{options.onAttempt?.({attempt,status,durationMs:Date.now()-started,usage,usageComplete,transportObservation});}catch(error){if(primary instanceof ModelCleanupUnknownError)primary.message+='；Token 用量记录未确认';else throw error;}}
    }catch(error){
    if(!networkReady||!(error instanceof FaultError)||!error.fault.retryable||attempt>=attempts||options.signal?.aborted)throw error;
    const delayMs=Math.ceil(retryDelay(attempt,error.retryAfterMs));if(!Number.isFinite(delayMs)||Date.now()+delayMs>=deadline)throw error;
    options.onRetry?.({attempt:attempt+1,delayMs,fault:error.fault});
    try{await sleep(delayMs,undefined,{signal:options.signal});}catch{throw new Error('模型退避等待已停止');}
    if(Date.now()>=deadline)throw error;
  }}}finally{if(eligible)tracker.commit(eligible);}
}
/**
 * inferAttempt - 执行单次模型推理请求
 * 负责发送冻结的请求体、解析 SSE 流和清理传输资源
 * @param prepared - 已验证的最终请求
 * @param onDelta - 流式输出回调
 * @param options - 推理选项
 * @returns 模型返回的文本
 */
async function inferAttempt(prepared:PreparedModelRequest,onDelta:((delta:string)=>void)|undefined,options:InferenceOptions,observation:ReturnType<typeof emptyTransport>,onHeaders:()=>void):Promise<string>{
  const {settings,api,key,headers,bodyText}=prepared,endpoint=new URL(prepared.endpoint);
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
      if(payload==='[DONE]'){if(api!=='openai-completions'||!complete)throw new Error('模型流结束标记不符合协议');observe(null,true);terminal=true;observation.terminal=true;return;}
      const data=JSON.parse(payload) as Json;
      if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('模型流事件格式无效');
      observe(api==='openai-responses'?data.response?.usage:api==='anthropic-messages'&&data.type==='message_start'?data.message?.usage:data.usage);
      if(data.error||['error','response.failed','response.incomplete'].includes(data.type))throw serviceFailure(data);
      if(api==='openai-completions'){
        const c=data.choices?.[0];if(!c)return;if(c.index!==undefined&&c.index!==0)return;
        append(c.delta?.content);if(c.finish_reason){if(c.finish_reason!=='stop')throw new Error('模型流被截断或包含未提供的工具');complete=true;}
      }else if(api==='openai-responses'){
        if(data.type==='response.output_text.delta')append(data.delta);
        if(data.type==='response.completed'){const full=finalText(data.response,api);if(!answer)append(full);else if(full!==answer)throw new Error('模型流与最终文本不一致');observe(null,true);complete=true;terminal=true;observation.terminal=true;}
      }else{
        if(data.type==='content_block_start'&&data.content_block?.type==='text')append(data.content_block.text);
        if(data.type==='content_block_delta'&&data.delta?.type==='text_delta')append(data.delta.text);
        if(data.type==='message_delta'&&data.delta?.stop_reason){if(!['end_turn','stop_sequence'].includes(data.delta.stop_reason))throw new Error('模型消息流未完整结束');complete=true;}
        if(data.type==='message_stop'){if(!complete)throw new Error('模型消息流缺少停止原因');observe(null,true);terminal=true;observation.terminal=true;}
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
          response=incoming;observation.responseHeaders=true;onHeaders();if(settled){incoming.destroy();return;}phase='headers';
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
              const data=JSON.parse(raw+tail) as Json;observe(data.usage);answer=finalText(data,api);observation.terminal=true;observe(null,true);
              if(answer.length>100000)throw new Error('模型输出超过 100000 字符');onDelta?.(answer);
            }
            phase='protocol';finish(undefined,answer);
          }));
          incoming.on('close',()=>{if(!incoming.complete)failed();});
        });
        observation.requestCreated=true;
        request.on('socket',assigned=>{socket=assigned;assigned.once('connect',()=>{connected=true;});assigned.once('close',close);if(settled)assigned.destroy();});
        request.on('close',()=>{if(!socket)close();});
        request.on('error',failed);
        request.once('finish',()=>{observation.writeCompleted=true;if(!settled&&phase==='connection')phase='headers';});
        request.end(bodyText);
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
