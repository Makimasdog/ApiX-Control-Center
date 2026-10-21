import {reasoningParameters} from './conversation-models.js';
import {getProviderConfig,isLoopbackModelUrl,validateModelConfig} from './model-providers.js';
import {request as httpRequest, type ClientRequest, type IncomingMessage} from 'node:http';
import {request as httpsRequest} from 'node:https';
import type {Socket} from 'node:net';

export interface ModelSettings {provider:string;model:string;baseUrl:string;apiType:string;apiKeyEnv:string;reasoningEffort?:string}
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
  return new Error(['insufficient_quota','rate_limit_exceeded','rate_limit_error','quota_exceeded'].includes(code)?'模型服务额度不足或触发速率限制 (insufficient_quota)':'模型未返回可用答复（服务返回错误或未完成）');
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

export async function inferModel(saved:ModelSettings,prompt:string,onDelta?:(delta:string)=>void,options:{signal?:AbortSignal;timeoutMs?:number}={}):Promise<string>{
  const settings=directModelSettings(saved),api=settings.apiType,key=settings.apiKeyEnv?process.env[settings.apiKeyEnv]:undefined;
  if(Buffer.byteLength(prompt)>512*1024)throw new Error('模型上下文超过 512 KiB，请整理或拆分任务');
  const endpoint=new URL(settings.baseUrl);const suffix=api==='openai-completions'?'/chat/completions':api==='openai-responses'?'/responses':'/messages';
  let path=endpoint.pathname.replace(/\/+$/,'');if(!path.endsWith(suffix))path+=(api==='anthropic-messages'&&!path.endsWith('/v1')?'/v1':'')+suffix;endpoint.pathname=path;
  // Some Qwen thinking models require streaming even when the caller only needs the final JSON.
  const stream=true;
  const body=api==='openai-responses'?{model:settings.model,instructions:system,input:prompt,stream,store:false}:api==='anthropic-messages'?{model:settings.model,system,messages:[{role:'user',content:prompt}],max_tokens:8192,stream}:{model:settings.model,messages:[{role:'system',content:system},{role:'user',content:prompt}],stream};
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
  let settled=false,closed=false,phase='connection',timer:ReturnType<typeof setTimeout>|undefined;
  let close!:()=>void;const transportClosed=new Promise<void>(resolve=>{close=()=>{closed=true;resolve();};});
  let finish!:(error?:unknown,value?:string)=>void;
  const abort=()=>finish(new Error(`模型请求已停止（${phase}）`));
  try{
    let bytes=0,raw='',answer='',pending='',complete=false,terminal=false;const decoder=new TextDecoder();
    const append=(value:unknown)=>{if(typeof value!=='string')return;answer+=value;if(answer.length>100000)throw new Error('模型输出超过 100000 字符');onDelta?.(value);};
    const event=(frame:string)=>{
      const payload=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!payload)return;
      if(payload==='[DONE]'){if(api!=='openai-completions'||!complete)throw new Error('模型流结束标记不符合协议');terminal=true;return;}
      const data=JSON.parse(payload) as Json;
      if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('模型流事件格式无效');
      if(data.error||['error','response.failed','response.incomplete'].includes(data.type))throw serviceFailure(data);
      if(api==='openai-completions'){
        const c=data.choices?.[0];if(!c)return;if(c.index!==undefined&&c.index!==0)return;
        append(c.delta?.content);if(c.finish_reason){if(c.finish_reason!=='stop')throw new Error('模型流被截断或包含未提供的工具');complete=true;}
      }else if(api==='openai-responses'){
        if(data.type==='response.output_text.delta')append(data.delta);
        if(data.type==='response.completed'){const full=finalText(data.response,api);if(!answer)append(full);else if(full!==answer)throw new Error('模型流与最终文本不一致');complete=true;terminal=true;}
      }else{
        if(data.type==='content_block_start'&&data.content_block?.type==='text')append(data.content_block.text);
        if(data.type==='content_block_delta'&&data.delta?.type==='text_delta')append(data.delta.text);
        if(data.type==='message_delta'&&data.delta?.stop_reason){if(!['end_turn','stop_sequence'].includes(data.delta.stop_reason))throw new Error('模型消息流未完整结束');complete=true;}
        if(data.type==='message_stop'){if(!complete)throw new Error('模型消息流缺少停止原因');terminal=true;}
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
      const failed=()=>finish(new Error(`模型连接或传输失败（${phase}）；没有自动重试`));
      const guarded=(work:()=>void)=>{if(settled)return;try{work();}catch(error){finish(error);}};
      timer=setTimeout(()=>finish(new Error(`模型请求超时（${timeoutMs} ms，${phase}）；没有自动重试`)),timeoutMs);
      options.signal?.addEventListener('abort',abort,{once:true});
      try{
        request=(endpoint.protocol==='https:'?httpsRequest:httpRequest)(endpoint,{method:'POST',headers,agent:false},incoming=>{
          response=incoming;if(settled){incoming.destroy();return;}phase='headers';
          incoming.on('error',failed);
          incoming.on('aborted',failed);
          const status=incoming.statusCode??0;
          if(status<200||status>=300){finish(new Error(status===429?'模型服务额度不足或触发速率限制 (HTTP 429)':`模型服务返回 HTTP ${status}，请检查地址、模型、认证和账户额度`));return;}
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
              answer=finalText(JSON.parse(raw+tail) as Json,api);
              if(answer.length>100000)throw new Error('模型输出超过 100000 字符');onDelta?.(answer);
            }
            phase='protocol';finish(undefined,answer);
          }));
          incoming.on('close',()=>{if(!incoming.complete)failed();});
        });
        request.on('socket',assigned=>{socket=assigned;assigned.once('close',close);if(settled)assigned.destroy();});
        request.on('close',()=>{if(!socket)close();});
        request.on('error',failed);
        request.once('finish',()=>{if(!settled&&phase==='connection')phase='headers';});
        request.end(JSON.stringify(body));
      }catch(error){finish(error);}
    });
  }catch(error){
    let message=error instanceof Error?error.message:'模型调用失败';
    if(error instanceof SyntaxError||error instanceof TypeError)message='模型服务无法连接或响应格式无效，请检查 API 地址、协议和服务状态';
    if(key)message=message.split(key).join('<redacted>');throw new Error(message.slice(0,1000));
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
